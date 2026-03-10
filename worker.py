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

import json
import os
import sys
import threading

import numpy as np

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
        # Set by load_pipeline_ini; used by run_likelihood for actual I/O attribution
        self._pipeline_modules = []
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
        # Reset pipeline / results / per-module data whenever a new ini is loaded.
        self._pipeline         = None
        self._results          = None
        self._pipeline_modules = []

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

        # Retain for later use by run_likelihood (actual I/O attribution).
        self._pipeline_modules = pipeline_mods

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

        # Capture *all* output at the OS file-descriptor level so that writes
        # from CosmoSIS C extensions (which bypass Python's redirect_stdout)
        # are also included.  Both stdout (fd 1) and stderr (fd 2) feed into
        # the same pipe so their lines remain interleaved in arrival order.
        cap   = _FdCapture([1, 2])
        error = None
        try:
            self._pipeline = LikelihoodPipeline(self._inifile)
        except Exception as exc:
            error = exc
        finally:
            captured = cap.finish()

        if error is not None:
            raise RuntimeError(
                f"Pipeline setup failed: {error}"
                + (f"\n\n--- Captured output ---\n{captured}" if captured else "")
            )
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

        Returns per-module actual I/O extracted from the DataBlock log so that
        the frontend can replace the YAML-declared inputs/outputs with what was
        actually accessed during the run.
        """
        if self._pipeline is None:
            raise ValueError(
                "Pipeline not prepared. Click 'Prepare Pipeline' first."
            )

        cap   = _FdCapture([1, 2])
        error = None
        try:
            v             = self._pipeline.start_vector()
            self._results = self._pipeline.run_results(v)
        except Exception as exc:
            error = exc
        finally:
            captured = cap.finish()

        if error is not None:
            raise RuntimeError(
                f"Likelihood run failed: {error}"
                + (f"\n\n--- Captured output ---\n{captured}" if captured else "")
            )

        block      = getattr(self._results, "block", None)
        per_module = _extract_actual_module_io(block, self._pipeline_modules)

        print(
            f"[worker] run_likelihood: {len(per_module)} modules with actual I/O.",
            file=sys.stderr,
        )
        return {"ok": True, "modules": per_module}

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


class _FdCapture:
    """Capture all writes to a set of OS file descriptors via a pipe.

    Works for *both* Python-level writes (via ``sys.stdout`` / ``sys.stderr``)
    and direct C-extension writes to the underlying file descriptor — the
    latter are the ones that bypass Python's ``redirect_stdout`` context
    manager.

    Usage::

        cap = _FdCapture([1, 2])     # start capturing fd 1 + fd 2
        try:
            do_something_that_produces_output()
        finally:
            text = cap.finish()      # restore fds, return captured text
    """

    def __init__(self, fds):
        self._fds = list(fds)

        # Flush Python wrappers before redirecting so no buffered data leaks
        # into the capture pipe from a previous call.
        _ipc_stdout.flush()
        try:
            sys.stderr.flush()
        except Exception:
            pass

        # Save a copy of each fd so we can restore later.
        self._saved = {fd: os.dup(fd) for fd in self._fds}

        # All captured fds write into the *same* pipe so output is interleaved
        # in arrival order, just as a reader would see it.
        r, w = os.pipe()
        for fd in self._fds:
            os.dup2(w, fd)
        os.close(w)  # Only the dup'd fds keep the write end alive now.

        self._chunks: list[bytes] = []
        self._t = threading.Thread(target=self._drain, args=(r,), daemon=True)
        self._t.start()

    def _drain(self, r: int) -> None:
        """Background reader: drains the pipe until all writers close it."""
        while True:
            try:
                chunk = os.read(r, 4096)
            except OSError:
                break
            if not chunk:
                break
            self._chunks.append(chunk)
        try:
            os.close(r)
        except OSError:
            pass

    def finish(self) -> str:
        """Restore original fds and return all text written during capture."""
        # Flush Python-level wrappers one last time to drain any buffered data
        # into the pipe before we close the write ends.
        try:
            _ipc_stdout.flush()
        except Exception:
            pass
        try:
            sys.stderr.flush()
        except Exception:
            pass

        # Restore originals.  Each os.dup2 closes the redirected fd's handle
        # to the write end of the pipe; the last one causes EOF in the drain
        # thread.
        for fd in self._fds:
            os.dup2(self._saved[fd], fd)
            os.close(self._saved[fd])

        self._t.join(timeout=10)
        if self._t.is_alive():
            # The drain thread is still running after the timeout.  This is
            # unexpected but non-fatal: log a warning and continue with
            # whatever data has been collected so far.
            print(
                "[worker] _FdCapture: drain thread did not finish within 10 s"
                " — output may be incomplete.",
                file=sys.stderr,
            )

        # Safe to read: _t.join() ensures the thread has finished (or we've
        # already warned that it's still alive, in which case the GIL protects
        # the list read against concurrent appends).
        return b"".join(self._chunks).decode("utf-8", errors="replace")


def _normalize_dtype(value):
    """Convert a DataBlock data_type (possibly a Python type object) to a display string."""
    if value is None:
        return ""
    if isinstance(value, int):
        return "int"
    elif isinstance(value, float):
        return "real"
    elif isinstance(value, str):
        return "str"
    elif isinstance(value, bool):
        return "bool"
    elif isinstance(value, complex):
        return "complex"
    elif isinstance(value, np.ndarray):
        dt = value.dtype
        ndim = f"{value.ndim}D"
        if dt == 'int':
            return f"int {ndim}"
        elif dt == 'real':
            return f"real {ndim}"
        elif dt == 'complex':
            return f"complex {ndim}"
        elif dt == 'bool':
            return f"bool {ndim}"
        elif dt == 'str':
            return f"str {ndim}"
        else:
            return f"???? {ndim}"
    else:
        return "????"


def _extract_actual_module_io(block, pipeline_modules):
    """Extract per-module actual I/O from a CosmoSIS DataBlock log.

    Cross-references log entries (READ-OK / READ-DEFAULT / WRITE-OK /
    REPLACE-OK) against each module's YAML-declared input and output sections.

    Returns a list of dicts:

        {"ini_section": str,
         "actual_inputs":   [{"name": section, "type": "section",
                               "items": [{"name": key, "type": dtype}]}],
         "actual_defaults": [...],   # READ-DEFAULT entries — different colour
         "actual_outputs":  [...]}   # WRITE-OK / REPLACE-OK entries
    """
    if block is None or not pipeline_modules:
        return []

    try:
        count = block.get_log_count()
    except Exception:
        return []

    _READ_TYPES  = {"read-ok", "read-default"}
    _WRITE_TYPES = {"write-ok", "replace-ok"}

    # Collect all log entries into two maps:
    #   reads[(section_lc, name_lc)]  = {"access_type", "data_type", "section", "name"}
    #   writes[(section_lc, name_lc)] = {"access_type", "data_type", "section", "name"}
    # For reads: READ-OK supersedes READ-DEFAULT for the same key.
    reads  = {}
    writes = {}

    for i in range(count):
        try:
            entry = block.get_log_entry(i)
        except Exception:
            continue
        if not entry or len(entry) < 3:
            continue

        access_type = str(entry[0]).lower() if entry[0] is not None else ""
        section     = str(entry[1])         if entry[1] is not None else ""
        name        = str(entry[2])         if entry[2] is not None else ""
        if len(entry) <= 3:
            data_type = ""
        elif block.has_value(section, name):
            value = block[section, name]
            data_type = _normalize_dtype(value)

        key = (section.lower(), name.lower())

        if access_type in _WRITE_TYPES:
            writes[key] = {
                "access_type": access_type,
                "data_type":   data_type,
                "section":     section,
                "name":        name,
            }
        elif access_type in _READ_TYPES:
            existing = reads.get(key)
            # READ-OK takes priority over READ-DEFAULT for the same key.
            if existing is None or (
                access_type == "read-ok" and existing["access_type"] == "read-default"
            ):
                reads[key] = {
                    "access_type": access_type,
                    "data_type":   data_type,
                    "section":     section,
                    "name":        name,
                }

    result = []
    for mod in pipeline_modules:
        ini_section = mod.get("ini_section")
        if not ini_section:
            continue  # sampler module — no ini section, skip

        # Build lookup: lower-case section name → display name
        input_sections  = {
            p["name"].lower(): p["name"]
            for p in (mod.get("inputs") or [])
            if p.get("type") == "section"
        }
        output_sections = {
            p["name"].lower(): p["name"]
            for p in (mod.get("outputs") or [])
            if p.get("type") == "section"
        }

        # Actual inputs (READ-OK) and defaults (READ-DEFAULT) for declared input sections.
        actual_inputs   = []
        actual_defaults = []
        for sec_lc, sec_display in input_sections.items():
            ok_items  = []
            def_items = []
            for (s_lc, _n_lc), info in reads.items():
                if s_lc == sec_lc:
                    item = {"name": info["name"], "type": info["data_type"]}
                    if info["access_type"] == "read-ok":
                        ok_items.append(item)
                    else:
                        def_items.append(item)
            if ok_items:
                actual_inputs.append({
                    "name": sec_display, "type": "section", "items": ok_items,
                })
            if def_items:
                actual_defaults.append({
                    "name": sec_display, "type": "section", "items": def_items,
                })

        # Actual outputs (WRITE-OK / REPLACE-OK) for declared output sections.
        actual_outputs = []
        for sec_lc, sec_display in output_sections.items():
            items = []
            for (s_lc, _n_lc), info in writes.items():
                if s_lc == sec_lc:
                    items.append({"name": info["name"], "type": info["data_type"]})
            if items:
                actual_outputs.append({
                    "name": sec_display, "type": "section", "items": items,
                })

        result.append({
            "ini_section":     ini_section,
            "actual_inputs":   actual_inputs,
            "actual_defaults": actual_defaults,
            "actual_outputs":  actual_outputs,
        })

    return result


def _parse_module_output(combined, module_names):
    """Split captured output text into per-module chunks.

    CosmoSIS prints ``Setting up module <name>`` before each module's setup
    output, and ``Setup all pipeline modules`` at the very end.  We use these
    boundary markers to attribute lines to the correct module.

    Lines that appear before the first ``Setting up module`` marker are
    attributed to the first module (if any).

    Returns a list of ``{"ini_section": name, "output": text}`` dicts in
    pipeline order.
    """
    if not module_names:
        return []

    _SETUP_PREFIX = "setting up module "
    _SETUP_ALL    = "setup all pipeline modules"

    # Build ordered list of (line_index, module_name) for each "Setting up
    # module <name>" boundary, then a sentinel for the final "Setup all …" line.
    boundaries = []  # list of (line_number, module_name_or_None)
    lines      = combined.splitlines()

    for lineno, line in enumerate(lines):
        stripped = line.strip()
        lowered  = stripped.lower()
        if lowered.startswith(_SETUP_PREFIX):
            # Extract the module name token immediately after the prefix.
            rest       = stripped[len(_SETUP_PREFIX):].strip()
            parts      = rest.split()
            name_token = parts[0].rstrip(".,:;") if parts else ""
            # Find the matching pipeline module (case-insensitive prefix match).
            matched = None
            for m in module_names:
                if m.lower() == name_token.lower():
                    matched = m
                    break
            if matched is None and name_token:
                # Fallback: accept any module whose name starts with the token.
                for m in module_names:
                    if m.lower().startswith(name_token.lower()):
                        matched = m
                        break
            if matched:
                boundaries.append((lineno, matched))
        elif lowered.startswith(_SETUP_ALL):
            boundaries.append((lineno, None))  # sentinel: end of last module

    # Assign line ranges to modules.
    # If there are no boundaries, all output goes to the first module.
    module_lines = {name: [] for name in module_names}

    if not boundaries:
        # No "Setting up module" markers found — dump everything to the first module.
        if module_names:
            module_lines[module_names[0]] = lines
    else:
        # Lines before the first boundary → first recognised module.
        first_boundary_line = boundaries[0][0]
        if first_boundary_line > 0 and module_names:
            module_lines[module_names[0]].extend(lines[:first_boundary_line])

        for i, (start, name) in enumerate(boundaries):
            if name is None:
                break  # sentinel reached
            end = boundaries[i + 1][0] if i + 1 < len(boundaries) else len(lines)
            module_lines[name].extend(lines[start:end])

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
