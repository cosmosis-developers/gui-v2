import os
import yaml
from flask import Flask, render_template
from flask_cors import CORS
from flask_socketio import SocketIO, emit
from module_library import scan_directory, parse_module_yaml
from modules import get_available_modules, get_initial_pipeline
from inifile import Inifile

app = Flask(__name__)
app.config["SECRET_KEY"] = "cosmosis-gui-v2-secret"
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# ── Server-side state ──────────────────────────────────────────────────────
# Path of the most recently scanned library directory (None until set).
_library_directory = None
# Modules indexed by the absolute path of their module.yaml file so we can
# quickly look them up when loading a pipeline INI file.
_modules_by_yaml_path = {}


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def handle_connect():
    emit("available_modules", get_available_modules())
    emit("pipeline_update", get_initial_pipeline())


@socketio.on("get_modules")
def handle_get_modules():
    emit("available_modules", get_available_modules())


@socketio.on("get_pipeline")
def handle_get_pipeline():
    emit("pipeline_update", get_initial_pipeline())


@socketio.on("scan_library_dir")
def handle_scan_library_dir(data):
    """Scan a directory of CosmoSIS module YAML files on the server.

    Receives ``{"path": "/absolute/path/to/cosmosis-standard-library"}``
    from the browser.  The Python layer does all file reading and stores
    the directory path for later use when loading pipeline INI files.
    """
    global _library_directory, _modules_by_yaml_path

    directory = (data or {}).get("path", "").strip()
    if not directory:
        emit("scan_error", {"message": "No directory path provided."})
        return

    directory = os.path.expanduser(os.path.expandvars(directory))
    if not os.path.isdir(directory):
        emit("scan_error", {"message": f"Not a directory: {directory!r}"})
        return

    try:
        modules = scan_directory(directory)
    except (ValueError, OSError) as exc:
        emit("scan_error", {"message": str(exc)})
        return

    _library_directory = directory
    # Build lookup table: yaml_path → module dict
    _modules_by_yaml_path = {m["_source"]: m for m in modules if m.get("_source")}

    emit("available_modules", modules)


@socketio.on("load_pipeline_ini")
def handle_load_pipeline_ini(data):
    """Load a CosmoSIS pipeline INI file and reconstruct the canvas state.

    Receives ``{"path": "/absolute/path/to/pipeline.ini"}`` from the browser.
    Steps:
      1. Parse the INI with ``Inifile``.
      2. Read ``pipeline.modules`` to get the ordered list of module names.
      3. For each module name, look up its ``file`` key, find the
         ``module.yaml`` in that directory, and match it against the scanned
         library.
      4. Apply any config keys from the module's INI section as ``paramValues``.
      5. Read ``pipeline.values`` to find the values file and use its sections
         / keys as the sampler's outputs.
      6. Emit ``pipeline_update`` with the resulting module list.
    """
    ini_path = (data or {}).get("path", "").strip()
    if not ini_path:
        emit("pipeline_load_error", {"message": "No INI file path provided."})
        return

    ini_path = os.path.expanduser(os.path.expandvars(ini_path))
    if not os.path.isfile(ini_path):
        emit("pipeline_load_error", {"message": f"File not found: {ini_path!r}"})
        return

    try:
        ini = Inifile(ini_path, print_include_messages=False)
    except Exception as exc:
        emit("pipeline_load_error", {"message": f"Failed to parse INI: {exc}"})
        return

    # ── pipeline.modules ──────────────────────────────────────────────
    try:
        modules_str = ini.get("pipeline", "modules", fallback="")
    except Exception:
        modules_str = ""

    module_names = modules_str.split() if modules_str else []

    # ── pipeline.values → sampler outputs ────────────────────────────
    sampler_module = _build_sampler_from_values(ini, ini_path)

    # ── Build pipeline list ────────────────────────────────────────────
    pipeline_modules = [sampler_module]

    ini_dir = os.path.dirname(os.path.abspath(ini_path))

    for mod_name in module_names:
        if not ini.has_section(mod_name):
            continue

        module_file = ini.get(mod_name, "file", fallback="")
        mod_dict = _resolve_module(mod_name, module_file, ini_dir)

        # Apply INI config values as paramValues
        param_values = {}
        reserved = {"file", "version", "keep_cosmosis_policy"}
        for key, value in _ini_section_items(ini, mod_name):
            if key not in reserved:
                param_values[key] = value
        mod_dict["paramValues"] = param_values

        pipeline_modules.append(mod_dict)

    emit("pipeline_update", pipeline_modules)


# ── Helpers ────────────────────────────────────────────────────────────────

def _build_sampler_from_values(ini, ini_path):
    """Build a Sampler module whose outputs come from a ``values`` INI file.

    The ``pipeline.values`` key points to another ``.ini`` file whose
    sections are data-block section names and whose keys are parameter names.
    Each section in the values file becomes one output section-port.
    """
    from modules import SAMPLER_MODULE

    sampler = dict(SAMPLER_MODULE)  # shallow copy

    values_path_raw = ini.get("pipeline", "values", fallback="")
    if not values_path_raw:
        return sampler

    values_path = os.path.expandvars(values_path_raw.strip())
    if not os.path.isabs(values_path):
        values_path = os.path.join(os.path.dirname(os.path.abspath(ini_path)),
                                   values_path)
    values_path = os.path.normpath(values_path)

    if not os.path.isfile(values_path):
        # Also try relative to the library directory
        if _library_directory and not os.path.isabs(values_path_raw.strip()):
            alt = os.path.normpath(
                os.path.join(_library_directory, values_path_raw.strip())
            )
            if os.path.isfile(alt):
                values_path = alt

    if not os.path.isfile(values_path):
        return sampler  # file not found — use default sampler

    try:
        val_ini = Inifile(values_path, print_include_messages=False)
    except Exception:
        return sampler

    # One output section-port per section in the values file
    outputs = []
    for section in val_ini.sections():
        items = [
            {"name": name, "type": "real", "description": ""}
            for name, _ in _ini_section_items(val_ini, section)
        ]
        outputs.append({
            "name": section,
            "type": "section",
            "description": "",
            "items": items,
        })

    if outputs:
        sampler = dict(sampler)
        sampler["outputs"] = outputs

    return sampler


def _resolve_module(mod_name, module_file, ini_dir):
    """Return a module dict for the given INI section.

    Tries to match the module against the scanned library; falls back to
    a minimal placeholder if the YAML cannot be found.

    Path resolution order:
      1. Absolute path (after env-var expansion)
      2. Relative to ini_dir
      3. Relative to the scanned library directory (_library_directory)
    """
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
        expanded = os.path.expandvars(module_file.strip())

        # Candidate directories to search in
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
            result = _try_yaml(yaml_path)
            if result:
                return result

    # Fall back: create a minimal placeholder from the INI section name
    return {
        "id": mod_name,
        "name": mod_name,
        "category": "Unknown",
        "description": (
            f"Module loaded from pipeline ini "
            f"(no YAML found for '{module_file}')"
        ),
        "inputs": [],
        "outputs": [],
        "params": [],
        "_source": module_file or "",
    }


def _ini_section_items(ini, section):
    """Return (key, value) pairs for a section, excluding DEFAULT entries.

    Works with both the real cosmosis Inifile (which has a ``defaults``
    keyword on its ``items()`` method) and with the bundled fallback that
    relies on the standard-library ConfigParser.
    """
    try:
        # Real cosmosis Inifile has items(section, defaults=False)
        return list(ini.items(section, defaults=False))
    except TypeError:
        pass
    # Fallback: use the public dict-style access (ini[section]) which returns
    # a proxy that includes DEFAULT values, then filter them out by comparing
    # against the raw section keys via ini.options(section).
    try:
        section_keys = set(ini.options(section)) - set(ini.defaults().keys())
        return [(k, ini.get(section, k)) for k in section_keys]
    except Exception:
        return []


if __name__ == "__main__":
    socketio.run(app, debug=True, port=8080, allow_unsafe_werkzeug=True)
