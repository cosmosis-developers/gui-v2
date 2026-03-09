# CosmoSIS GUI v2

A graphical pipeline editor for [CosmoSIS](https://cosmosis.readthedocs.io/).
Built with **Electron** (frontend shell) and **Python** (backend logic via stdin/stdout IPC).

---

## Architecture

The GUI uses a clean Electron-native architecture — no HTTP server required:

```
Electron main process
  ├─ loads templates/index.html  via loadFile()  (file:// — no port)
  ├─ spawns worker.py as a child process
  └─ bridges IPC calls:  renderer ↔ ipcMain ↔ worker.py stdin/stdout
```

All Python I/O (scanning module libraries, parsing pipeline INI files) is
handled by `worker.py` — a simple JSON-RPC worker that reads requests from
stdin and writes responses to stdout.  This replaces the previous
Flask/Socket.IO HTTP server approach, which had several drawbacks:

| | Old (Flask) | New (IPC) |
|-|-------------|-----------|
| Port conflicts | Yes (macOS blocked 5000) | None |
| Startup delay | 200 ms polling loop | Instant |
| Extra Python deps | Flask, flask-socketio, flask-cors, simple-websocket | None |
| Security surface | localhost HTTP socket | Subprocess pipe only |

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

Electron will spawn `worker.py` as a subprocess and open the window immediately.

---

## Usage

* **Open Library** — click the button in the left sidebar and choose the root
  of a CosmoSIS standard library directory.  The Python worker recursively
  scans for `module.yaml` files and populates the module library panel.

* **Open Pipeline** — click the button and choose a CosmoSIS `.ini` pipeline
  file.  The worker parses it with `Inifile`, resolves each module against
  the scanned library, and populates the pipeline canvas.

* **Drag modules** from the library panel onto the canvas to build a custom
  pipeline.
