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

This replaces the previous Flask/Socket.IO backend, removing all HTTP-server
dependencies (Flask, flask-socketio, flask-cors, simple-websocket) and
eliminating port-conflict issues that affected macOS.
"""

import json
import os
import sys

from inifile import Inifile
from module_library import parse_module_yaml, scan_directory
from modules import SAMPLER_MODULE, get_available_modules, get_initial_pipeline

# ── Server-side state ──────────────────────────────────────────────────────
_library_directory    = None
_modules_by_yaml_path = {}


# ── Handlers ──────────────────────────────────────────────────────────────

def handle_get_modules(_params):
    return get_available_modules()


def handle_get_pipeline(_params):
    return get_initial_pipeline()


def handle_scan_library_dir(params):
    global _library_directory, _modules_by_yaml_path

    directory = (params or {}).get("path", "").strip()
    if not directory:
        raise ValueError("No directory path provided.")

    directory = os.path.expanduser(os.path.expandvars(directory))
    if not os.path.isdir(directory):
        raise ValueError(f"Not a directory: {directory!r}")

    modules = scan_directory(directory)

    # Change the current working directory to the library directory, so that any
    # relative paths in the ini files we will load later are resolved correctly.
    os.chdir(directory)

    _library_directory    = directory
    _modules_by_yaml_path = {m["_source"]: m for m in modules if m.get("_source")}

    return modules


def handle_load_pipeline_ini(params):
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

    try:
        modules_str = ini.get("pipeline", "modules", fallback="")
    except Exception:
        modules_str = ""

    module_names   = modules_str.split() if modules_str else []
    sampler_module = _build_sampler_from_values(ini, ini_path)
    pipeline_mods  = [sampler_module]
    ini_dir        = os.path.dirname(os.path.abspath(ini_path))

    for mod_name in module_names:
        if not ini.has_section(mod_name):
            continue
        module_file = ini.get(mod_name, "file", fallback="")
        mod_dict    = _resolve_module(mod_name, module_file, ini_dir)

        param_values = {}
        reserved     = {"file", "version", "keep_cosmosis_policy"}
        for key, value in _ini_section_items(ini, mod_name):
            if key not in reserved:
                param_values[key] = value
        mod_dict["paramValues"] = param_values
        pipeline_mods.append(mod_dict)

    return pipeline_mods


# ── Helpers ────────────────────────────────────────────────────────────────

def _build_sampler_from_values(ini, ini_path):
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

    if not os.path.isfile(values_path) and _library_directory \
            and not os.path.isabs(values_path_raw.strip()):
        alt = os.path.normpath(
            os.path.join(_library_directory, values_path_raw.strip())
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
        outputs.append({"name": section, "type": "section", "description": "", "items": items})

    if outputs:
        sampler = dict(sampler)
        sampler["outputs"] = outputs

    return sampler


def _resolve_module(mod_name, module_file, ini_dir):
    def _try_yaml(yaml_path):
        if yaml_path in _modules_by_yaml_path:
            return dict(_modules_by_yaml_path[yaml_path])
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
            if _library_directory:
                candidates.append(
                    os.path.dirname(os.path.join(_library_directory, expanded))
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


def _ini_section_items(ini, section):
    try:
        return list(ini.items(section, defaults=False))
    except TypeError:
        pass
    try:
        section_keys = set(ini.options(section)) - set(ini.defaults().keys())
        return [(k, ini.get(section, k)) for k in section_keys]
    except Exception:
        return []


# ── Main dispatch loop ─────────────────────────────────────────────────────

_DISPATCH = {
    "get_modules":       handle_get_modules,
    "get_pipeline":      handle_get_pipeline,
    "scan_library_dir":  handle_scan_library_dir,
    "load_pipeline_ini": handle_load_pipeline_ini,
}


def _reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
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
        handler = _DISPATCH.get(method)

        if handler:
            try:
                result = handler(params)
                _reply({"id": req_id, "result": result, "error": None})
            except Exception as exc:
                _reply({"id": req_id, "result": None, "error": str(exc)})
        else:
            _reply({"id": req_id, "result": None, "error": f"Unknown method: {method!r}"})


if __name__ == "__main__":
    main()
