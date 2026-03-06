# CosmoSIS GUI v2

A graphical pipeline editor for [CosmoSIS](https://cosmosis.readthedocs.io/).
Built with **Electron** (frontend shell) and **Python / Flask-SocketIO** (backend).

---

## Requirements

| Tool | Version |
|------|---------|
| Python | ≥ 3.9 |
| Node.js | ≥ 18 |
| CosmoSIS | ≥ 3.22 |

---

## Getting started

### 1 — Install Python dependencies

```bash
pip install -r requirements.txt
```

### 2 — Install Node.js / Electron dependencies

```bash
npm install
```

### 3 — Run the application

```bash
npm start
```

This will:
1. Spawn the Python Flask/Socket.IO backend on `http://localhost:8080`.
2. Open the Electron window once the backend is ready.

---

## Usage

* **Open Library** — click the button in the left sidebar and choose the root
  of a CosmoSIS standard library directory.  The Python backend recursively
  scans for `module.yaml` files and populates the module library panel.

* **Open Pipeline** — click the button and choose a CosmoSIS `.ini` pipeline
  file.  The backend parses it with `Inifile`, resolves each module against
  the scanned library, and populates the pipeline canvas.

* **Drag modules** from the library panel onto the canvas to build a custom
  pipeline.

---

## Development

For quicker iteration you can also run the Flask backend directly and open the
page in a regular browser (file-system dialogs will fall back to `prompt()`):

```bash
python app.py
# then open http://localhost:8080
```
