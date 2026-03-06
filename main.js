/**
 * main.js — Electron main process for the CosmoSIS GUI.
 *
 * Responsibilities:
 *  1. Spawn the Python Flask / Socket.IO backend as a child process.
 *  2. Wait until the backend HTTP server is accepting connections.
 *  3. Open a BrowserWindow pointing at http://localhost:8080.
 *  4. Forward native OS dialog requests from the renderer via ipcMain.
 *  5. Terminate the Python process when the window is closed.
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path    = require("path");
const http    = require("http");
const { spawn } = require("child_process");

// ── Configuration ──────────────────────────────────────────────────────────
const BACKEND_PORT    = 8080;
const BACKEND_URL     = `http://localhost:${BACKEND_PORT}`;
const POLL_INTERVAL_MS = 200;   // how often to ping the backend while starting
const POLL_TIMEOUT_MS  = 30000; // give up after 30 s

let backendProcess = null;
let mainWindow     = null;

// ── Start the Python backend ───────────────────────────────────────────────
function startBackend() {
  // Determine the Python executable to use.
  // If running from an asar package use the resources path; during dev use cwd.
  const appDir = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : path.join(__dirname);

  const pythonExe = process.platform === "win32" ? "python" : "python3";

  backendProcess = spawn(
    pythonExe,
    [path.join(appDir, "app.py")],
    {
      cwd: appDir,
      env: { ...process.env },
      // pipe stdout/stderr so we can log them in the Electron console
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  backendProcess.stdout.on("data", d =>
    process.stdout.write(`[python] ${d}`)
  );
  backendProcess.stderr.on("data", d =>
    process.stderr.write(`[python] ${d}`)
  );

  backendProcess.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
      console.error(`[python] exited with code=${code} signal=${signal}`);
    }
  });
}

// ── Poll until Flask is ready ──────────────────────────────────────────────
function waitForBackend() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    function ping() {
      http
        .get(BACKEND_URL, res => {
          res.resume(); // drain the response body
          resolve();
        })
        .on("error", () => {
          if (Date.now() >= deadline) {
            reject(new Error("Timed out waiting for the Python backend."));
          } else {
            setTimeout(ping, POLL_INTERVAL_MS);
          }
        });
    }

    ping();
  });
}

// ── Create the browser window ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    title:  "CosmoSIS",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Keep Node.js out of the renderer; the preload exposes what we need.
      contextIsolation: true,
      nodeIntegration:  false,
      // Allow Socket.IO to connect to the local Flask server.
      webSecurity: true,
    },
  });

  mainWindow.loadURL(BACKEND_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── IPC handlers — native dialogs ─────────────────────────────────────────

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

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  startBackend();

  try {
    await waitForBackend();
  } catch (err) {
    console.error(err.message);
    app.quit();
    return;
  }

  createWindow();

  // macOS: re-open window when dock icon is clicked and no windows are open.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Terminate the Python backend.
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }

  // On non-macOS platforms, quit the app when all windows are closed.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
});
