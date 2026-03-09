"""CosmoSIS GUI — Python JSON-RPC worker.

Communicates with the Electron main process exclusively over stdin/stdout.
No HTTP server, no ports, no startup delay.

Protocol
--------
Each newline-delimited JSON object on **stdin** is a request::

    {"id": N, "method": "scan_library_dir", "params": {"path": "..."}}

Each newline-delimited JSON object on **stdout** is a response::

    {"id": N, "result": [...], "error": null}
    {"id": N, "result": null,  "error": "Human-readable error message"}

Architecture
------------
All state is encapsulated in a single ``Backend`` instance.  The main loop
deserialises each request line and dispatches it to the appropriate method.
"""

import io
import json
import os
import re
import sys
from contextlib import redirect_stderr, redirect_stdout

from inifile import Inifile
from module_library import parse_module_yaml, scan_directory
from modules import SAMPLER_MODULE, get_available_modules, get_initial_pipeline

# ── Save the real stdout FD at startup ────────────────────────────────────
# All JSON-RPC replies must go to this object.  It is saved *before* any
# stdout redirection happens so that it always points at the actual pipe
# connecting this process to the Electron main process.
_ipc_stdout = sys.stdout


def _reply(obj):
    _ipc_stdout.write(json.dumps(obj) + "\n")
    _ipc_stdout.flush()


# ── Backend ────────────────────────────────────────────────────────────────

class Backend:
    """Owns all mutable state and handles every JSON-RPC method call."""

    def __init__(self):
        self._library_directory    = None
        self._modules_by_yaml_path = {}
        # Retained after load_pipeline_ini; updated by update_param
        self._inifile  = None
        # Set by prepare_pipeline
        self._pipeline = None
        # Set by run_likelihood
        self._results  = None

    # ── Read-only queries ──────────────────────────────────────────────────

    def get_modules(self, _params):
        return get_available_modules()

    def get_pipeline(self, _params):
        return get_initial_pipeline()

    # ── Library scanning ───────────────────────────────────────────────────

    def scan_library_dir(self, params):
        directory = (params or {}).get("path", "").strip()
        if not directory:
            raise ValueError("No directory path provided.")

        directory = os.path.expanduser(os.path.expandvars(directory))
        if not os.path.isdir(directory):
            raise ValueError(f"Not a directory: {directory!r}")

        modules = scan_directory(directory)

        # Change the cwd so that relative paths inside ini files resolve
        # correctly when a pipeline is subsequently loaded.
        os.chdir(directory)

        self._library_directory    = directory
        self._modules_by_yaml_path = {
            m["_source"]: m for m in modules if m.get("_source")
        }

        return modules

    # ── Pipeline INI loading ───────────────────────────────────────────────

    def load_pipeline_ini(self, params):
        ini_path = (params or {}).get("path", "").strip()
        if not ini_path:
            raise ValueError("No INI file path provided.")

        ini_path = os.path.expanduser(os.path.expandvars(ini_path))
        if not os.path.isfile(ini_path):
            raise FileNotFoundError(f"File not found: {ini_path!r}")

        try:
            ini = Inifile(ini_path, print_include_messages=False)
        except Exception as exc:
            raise RuntimeError(f"Failed to parse INI: {exc}") from exc

        # Retain the Inifile so that param updates and pipeline creation can
        # operate on the same in-memory object.
        self._inifile = ini
        # Reset pipeline / results whenever a new ini is loaded.
        self._pipeline = None
        self._results  = None

        try:
            modules_str = ini.get("pipeline", "modules", fallback="")
        except Exception:
            modules_str = ""

        module_names   = modules_str.split() if modules_str else []
        sampler_module = self._build_sampler_from_values(ini, ini_path)
        pipeline_mods  = [sampler_module]
        ini_dir        = os.path.dirname(os.path.abspath(ini_path))

        for mod_name in module_names:
            if not ini.has_section(mod_name):
                continue
            module_file = ini.get(mod_name, "file", fallback="")
            mod_dict    = self._resolve_module(mod_name, module_file, ini_dir)

            # Record the ini-section name so the UI can route param updates.
            mod_dict["ini_section"] = mod_name

            param_values = {}
            reserved     = {"file", "version", "keep_cosmosis_policy"}
            for key, value in _ini_section_items(ini, mod_name):
                if key not in reserved:
                    param_values[key] = value
            mod_dict["paramValues"] = param_values
            pipeline_mods.append(mod_dict)

        return pipeline_mods

    # ── Param update (from UI changes) ────────────────────────────────────

    def update_param(self, params):
        """Apply a single param change from the UI to the in-memory Inifile.

        Expects ``{"ini_section": str, "key": str, "value": str}``.
        """
        if self._inifile is None:
            # No pipeline loaded yet — nothing to update.
            return {"ok": False, "reason": "No pipeline loaded."}

        ini_section = (params or {}).get("ini_section", "").strip()
        key         = (params or {}).get("key", "").strip()
        value       = str((params or {}).get("value", ""))

        if not ini_section or not key:
            raise ValueError("update_param requires 'ini_section' and 'key'.")

        if not self._inifile.has_section(ini_section):
            self._inifile.add_section(ini_section)

        self._inifile.set(ini_section, key, value)
        return {"ok": True}

    # ── Pipeline preparation ───────────────────────────────────────────────

    def prepare_pipeline(self, _params):
        """Create a ``LikelihoodPipeline`` from the current Inifile.

        Steps:
          1. Set ``[runtime] verbosity = noisy``.
          2. Create ``cosmosis.runtime.pipeline.LikelihoodPipeline``.
          3. Capture stdout + stderr produced during setup.
          4. Parse captured output into per-module chunks.
          5. Return ``{"modules": [{"ini_section", "output"}, ...]}``.
        """
        if self._inifile is None:
            raise ValueError(
                "No pipeline loaded. Use 'Open Pipeline' to load a .ini file first."
            )

        try:
            from cosmosis.runtime.pipeline import LikelihoodPipeline
        except ImportError as exc:
            raise ImportError(
                "CosmoSIS must be installed to prepare the pipeline "
                f"(cosmosis>=3.22).  Original error: {exc}"
            ) from exc

        # Set verbosity before building the pipeline.
        if not self._inifile.has_section("runtime"):
            self._inifile.add_section("runtime")
        self._inifile.set("runtime", "verbosity", "noisy")

        out_buf = io.StringIO()
        err_buf = io.StringIO()

        try:
            with redirect_stdout(out_buf), redirect_stderr(err_buf):
                self._pipeline = LikelihoodPipeline(self._inifile)
        except Exception as exc:
            captured = out_buf.getvalue() + err_buf.getvalue()
            raise RuntimeError(
                f"Pipeline setup failed: {exc}"
                + (f"\n\n--- Captured output ---\n{captured}" if captured else "")
            ) from exc

        captured     = out_buf.getvalue() + err_buf.getvalue()
        module_names = self._pipeline_module_names()
        per_module   = _parse_module_output(captured, module_names)

        print(
            f"[worker] prepare_pipeline: {len(module_names)} modules ready.",
            file=sys.stderr,
        )

        return {"modules": per_module, "all": captured}

    # ── Likelihood run ─────────────────────────────────────────────────────

    def run_likelihood(self, _params):
        """Run one likelihood evaluation using the prepared pipeline.

        Calls ``pipeline.start_vector()`` then ``pipeline.run_results(v)``
        and stores the returned results object for later use.
        """
        if self._pipeline is None:
            raise ValueError(
                "Pipeline not prepared. Click 'Prepare Pipeline' first."
            )

        out_buf = io.StringIO()
        err_buf = io.StringIO()

        try:
            with redirect_stdout(out_buf), redirect_stderr(err_buf):
                v              = self._pipeline.start_vector()
                self._results  = self._pipeline.run_results(v)
        except Exception as exc:
            captured = out_buf.getvalue() + err_buf.getvalue()
            raise RuntimeError(
                f"Likelihood run failed: {exc}"
                + (f"\n\n--- Captured output ---\n{captured}" if captured else "")
            ) from exc

        print(f"[worker] run_likelihood results: {self._results}", file=sys.stderr)
        return {"ok": True}

    # ── Internal helpers ───────────────────────────────────────────────────

    def _pipeline_module_names(self):
        """Return the ordered list of module names from pipeline.modules."""
        if self._inifile is None:
            return []
        try:
            s = self._inifile.get("pipeline", "modules", fallback="")
        except Exception:
            s = ""
        return s.split() if s else []

    def _build_sampler_from_values(self, ini, ini_path):
        sampler = dict(SAMPLER_MODULE)

        values_path_raw = ini.get("pipeline", "values", fallback="")
        if not values_path_raw:
            return sampler

        values_path = os.path.expandvars(values_path_raw.strip())
        if not os.path.isabs(values_path):
            values_path = os.path.join(
                os.path.dirname(os.path.abspath(ini_path)), values_path
            )
        values_path = os.path.normpath(values_path)

        if not os.path.isfile(values_path) and self._library_directory \
                and not os.path.isabs(values_path_raw.strip()):
            alt = os.path.normpath(
                os.path.join(self._library_directory, values_path_raw.strip())
            )
            if os.path.isfile(alt):
                values_path = alt

        if not os.path.isfile(values_path):
            return sampler

        try:
            val_ini = Inifile(values_path, print_include_messages=False)
        except Exception:
            return sampler

        outputs = []
        for section in val_ini.sections():
            items = [
                {"name": name, "type": "real", "description": ""}
                for name, _ in _ini_section_items(val_ini, section)
            ]
            outputs.append({
                "name": section, "type": "section",
                "description": "", "items": items,
            })

        if outputs:
            sampler = dict(sampler)
            sampler["outputs"] = outputs

        return sampler

    def _resolve_module(self, mod_name, module_file, ini_dir):
        def _try_yaml(yaml_path):
            if yaml_path in self._modules_by_yaml_path:
                return dict(self._modules_by_yaml_path[yaml_path])
            if os.path.isfile(yaml_path):
                try:
                    with open(yaml_path, encoding="utf-8", errors="replace") as fh:
                        text = fh.read()
                    parsed = parse_module_yaml(text, source_path=yaml_path)
                    if parsed:
                        return parsed
                except OSError:
                    pass
            return None

        if module_file:
            expanded   = os.path.expandvars(module_file.strip())
            candidates = []
            if os.path.isabs(expanded):
                candidates.append(os.path.dirname(expanded))
            else:
                candidates.append(os.path.dirname(os.path.join(ini_dir, expanded)))
                if self._library_directory:
                    candidates.append(
                        os.path.dirname(
                            os.path.join(self._library_directory, expanded)
                        )
                    )
            for cand_dir in candidates:
                yaml_path = os.path.normpath(os.path.join(cand_dir, "module.yaml"))
                result    = _try_yaml(yaml_path)
                if result:
                    return result

        return {
            "id":          mod_name,
            "name":        mod_name,
            "category":    "Unknown",
            "description": (
                f"Module loaded from pipeline ini "
                f"(no YAML found for '{module_file}')"
            ),
            "inputs":  [],
            "outputs": [],
            "params":  [],
            "_source": module_file or "",
        }


# ── Module-level helpers ───────────────────────────────────────────────────

def _ini_section_items(ini, section):
    """Return (key, value) pairs for *section*, excluding DEFAULT entries."""
    try:
        return list(ini.items(section, defaults=False))
    except TypeError:
        pass
    try:
        section_keys = set(ini.options(section)) - set(ini.defaults().keys())
        return [(k, ini.get(section, k)) for k in section_keys]
    except Exception:
        return []


def _parse_module_output(combined, module_names):
    """Split captured output text into per-module chunks.

    Strategy: scan line-by-line.  Whenever a line contains ``[module_name]``
    (the typical CosmoSIS log prefix), attribute that line — and all
    subsequent untagged lines — to that module.  Lines with no recognisable
    tag that precede the first recognised module tag are attributed to the
    first module by default.

    Returns a list of ``{"ini_section": name, "output": text}`` dicts in
    pipeline order.
    """
    # Compile a quick lookup: name → compiled pattern
    patterns = {
        name: re.compile(r"\[" + re.escape(name) + r"\]", re.IGNORECASE)
        for name in module_names
    }

    module_lines  = {name: [] for name in module_names}
    current_module = module_names[0] if module_names else None

    for line in combined.splitlines():
        attributed = False
        for name in module_names:
            if patterns[name].search(line):
                current_module = name
                module_lines[name].append(line)
                attributed = True
                break
        if not attributed and current_module:
            module_lines[current_module].append(line)

    return [
        {"ini_section": name, "output": "\n".join(module_lines[name])}
        for name in module_names
    ]


# ── Main dispatch loop ─────────────────────────────────────────────────────

def main():
    backend = Backend()

    dispatch = {
        "get_modules":        backend.get_modules,
        "get_pipeline":       backend.get_pipeline,
        "scan_library_dir":   backend.scan_library_dir,
        "load_pipeline_ini":  backend.load_pipeline_ini,
        "update_param":       backend.update_param,
        "prepare_pipeline":   backend.prepare_pipeline,
        "run_likelihood":     backend.run_likelihood,
    }

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _reply({"id": None, "result": None, "error": f"JSON decode error: {exc}"})
            continue

        req_id  = req.get("id")
        method  = req.get("method", "")
        params  = req.get("params") or {}
        handler = dispatch.get(method)

        if handler:
            try:
                result = handler(params)
                _reply({"id": req_id, "result": result, "error": None})
            except Exception as exc:
                _reply({"id": req_id, "result": None, "error": str(exc)})
        else:
            _reply({
                "id":     req_id,
                "result": None,
                "error":  f"Unknown method: {method!r}",
            })


if __name__ == "__main__":
    main()
