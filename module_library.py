"""CosmoSIS module library scanner.

Parses module.yaml files from a CosmoSIS standard library directory.
The Python layer is responsible for all YAML parsing and data extraction
so that other parts of the application can rely on the structured data.
"""

import os
import re

import yaml


def _safe_str(val):
    """Return val as a stripped string, or '' for None/falsy values."""
    if val is None:
        return ""
    return str(val).strip()


def _section_names(port_dict):
    """Return the top-level section names from an inputs/outputs mapping.

    Each key in the mapping is a section name (e.g. 'cosmological_parameters'),
    and its value is a dict of individual parameters.  We return just the
    section-name strings so the UI can show them as port labels.
    """
    if not isinstance(port_dict, dict):
        return []
    return [k for k, v in port_dict.items() if k and isinstance(v, dict)]


def parse_module_yaml(yaml_text, source_path=""):
    """Parse the text of a single module.yaml file.

    Returns a module dict compatible with the GUI, or None if the file is
    empty/a template (i.e. the ``name`` field is blank).

    The returned dict always contains a ``_raw`` key with the full parsed YAML
    data so that other parts of the application can access all fields without
    re-parsing.

    Inputs and outputs are represented as lists of ``{"name": section_name,
    "type": "section", "description": ""}`` dicts, using the YAML section
    names (e.g. ``cosmological_parameters``) rather than individual parameter
    names.
    """
    try:
        data = yaml.safe_load(yaml_text)
    except yaml.YAMLError:
        return None

    if not isinstance(data, dict):
        return None

    name = _safe_str(data.get("name", ""))
    if not name:
        # Template file or structurally empty — skip
        return None

    category = _safe_str(data.get("category", "")) or "Other"

    # Use 'purpose' as the short description; fall back to first line of 'explanation'
    description = _safe_str(data.get("purpose", ""))
    if not description:
        explanation = _safe_str(data.get("explanation", ""))
        description = explanation.split("\n")[0].strip().strip('" ')

    inputs_raw = data.get("inputs") or {}
    outputs_raw = data.get("outputs") or {}

    input_sections = _section_names(inputs_raw)
    output_sections = _section_names(outputs_raw)

    # Build a stable id from the name field
    module_id = re.sub(r"[^a-zA-Z0-9_]", "_", name).lower().strip("_")

    return {
        "id": module_id,
        "name": name,
        "category": category,
        "description": description,
        "inputs": [
            {"name": s, "type": "section", "description": ""}
            for s in input_sections
        ],
        "outputs": [
            {"name": s, "type": "section", "description": ""}
            for s in output_sections
        ],
        # Retain the complete parsed YAML for future use
        "_raw": data,
        "_source": source_path,
    }


def parse_yaml_files(file_list):
    """Parse a list of ``{"path": str, "content": str}`` dicts.

    This is the entry-point used when the browser sends the raw YAML file
    contents to the server (via the Socket.IO ``scan_library`` event).

    Returns a sorted list of module dicts (template/empty files omitted).
    """
    modules = []
    for item in file_list:
        path = item.get("path", "")
        content = item.get("content", "")
        module = parse_module_yaml(content, source_path=path)
        if module is not None:
            modules.append(module)

    modules.sort(key=lambda m: (m["category"].lower(), m["name"].lower()))
    return modules


def scan_directory(directory):
    """Walk *directory* recursively, find all ``module.yaml`` files, parse them.

    Returns a sorted list of module dicts (template/empty files omitted).
    Raises ``ValueError`` if *directory* is not a valid directory path.
    """
    directory = os.path.expanduser(directory)
    if not os.path.isdir(directory):
        raise ValueError(f"Not a directory: {directory!r}")

    modules = []
    for dirpath, _dirnames, filenames in os.walk(directory):
        for filename in filenames:
            if filename != "module.yaml":
                continue
            filepath = os.path.join(dirpath, filename)
            try:
                with open(filepath, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            module = parse_module_yaml(text, source_path=filepath)
            if module is not None:
                modules.append(module)

    modules.sort(key=lambda m: (m["category"].lower(), m["name"].lower()))
    return modules
