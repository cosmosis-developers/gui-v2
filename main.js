/**
 * main.js — Electron main process for the CosmoSIS GUI.
 *
 * Responsibilities:
 *  1. Spawn the Python JSON-RPC worker as a child process (stdin/stdout).
 *  2. Load the HTML page directly from disk — no HTTP server required.
 *  3. Forward native OS dialog requests from the renderer via ipcMain.
 *  4. Bridge Python calls from the renderer (IPC ↔ Python stdin/stdout).
 *  5. Terminate the Python process when the window is closed.
 *
 * Why no Flask?
 * The previous approach spawned a Flask/Socket.IO HTTP server on localhost and
 * polled it until ready before opening the window.  That caused port-conflict
 * issues on macOS and added four Python dependencies that this app doesn't need.
 * Since the GUI runs entirely inside Electron there is no reason for an HTTP
 * server: we load the HTML from disk with loadFile() and relay all Python I/O
 * through Electron's built-in IPC + a simple stdin/stdout JSON-RPC worker.
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path     = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

let pythonWorker = null;
let mainWindow   = null;

// ── App directory (script location, not launch CWD) ───────────────────────
const appDir = app.isPackaged
  ? path.join(process.resourcesPath, "app")
  : path.join(__dirname);

// ── In-flight JSON-RPC calls ───────────────────────────────────────────────
// Maps request id → { resolve, reject }
const _pending = new Map();
let   _nextId  = 1;

// ── Start the Python worker ────────────────────────────────────────────────
function startWorker() {
  const pythonExe = process.platform === "win32" ? "python" : "python3";

  pythonWorker = spawn(
    pythonExe,
    [path.join(appDir, "worker.py")],
    {
      cwd:   appDir,
      env:   { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  // Read responses line-by-line from the worker's stdout.
  // Only lines that begin with '{' are JSON-RPC responses; any other output
  // (e.g. direct prints from C extensions inside cosmosis that bypass the
  // Python-level stdout redirect) is forwarded to stderr for diagnostics.
  const rl = readline.createInterface({ input: pythonWorker.stdout });
  rl.on("line", line => {
    if (!line.startsWith("{")) {
      if (line.trim()) process.stderr.write(`[worker/stdout] ${line}\n`);
      return;
    }
    let resp;
    try { resp = JSON.parse(line); }
    catch (e) { console.error("[worker] JSON parse error:", e.message, "Line:", line); return; }

    const pending = _pending.get(resp.id);
    if (pending) {
      _pending.delete(resp.id);
      // Pass error as a plain string so the ipcMain handler can return it
      // directly to the renderer without losing the message.
      if (resp.error) pending.reject(resp.error);
      else            pending.resolve(resp.result);
    }
  });

  pythonWorker.stderr.on("data", d =>
    process.stderr.write(`[worker] ${d}`)
  );
  pythonWorker.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL")
      console.error(`[worker] exited code=${code} signal=${signal}`);
  });
}

// ── Send a JSON-RPC request to the Python worker ──────────────────────────
function callPython(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    pythonWorker.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

// ── Create the browser window ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    title:  "CosmoSIS",
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  });

  // Load the HTML directly from disk — no HTTP server needed.
  mainWindow.loadFile(path.join(__dirname, "templates", "index.html"));

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── IPC: native dialogs ───────────────────────────────────────────────────

ipcMain.handle("dialog:openDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:      "Select CosmoSIS standard library directory",
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:openIniFile", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title:   "Open CosmoSIS pipeline INI file",
    filters: [
      { name: "INI files", extensions: ["ini"] },
      { name: "All files", extensions: ["*"]   },
    ],
    properties: ["openFile"],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── IPC: startup auto-scan ────────────────────────────────────────────────
// If npm was launched from a directory different to the script directory,
// return that directory so the renderer can auto-scan it for modules.
ipcMain.handle("app:getStartupScanDir", () => {
  const launchDir = process.cwd();
  return path.resolve(launchDir) !== path.resolve(appDir) ? launchDir : null;
});

// ── IPC: Python calls ─────────────────────────────────────────────────────

ipcMain.handle("python:call", async (_event, { method, params }) => {
  try {
    const result = await callPython(method, params);
    return { result, error: null };
  } catch (err) {
    // err is the error string from the Python worker (or a Node Error if the
    // worker process itself fails).
    return { result: null, error: typeof err === "string" ? err : err.message };
  }
});

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startWorker();
  createWindow();

  // macOS: re-open window when dock icon is clicked and no windows are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (pythonWorker) { pythonWorker.kill(); pythonWorker = null; }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (pythonWorker) { pythonWorker.kill(); pythonWorker = null; }
});
