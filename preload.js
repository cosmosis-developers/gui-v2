/**
 * preload.js — runs in the renderer context with Node integration OFF.
 *
 * Exposes a minimal, safe API surface to the renderer via contextBridge so
 * that the page JavaScript can trigger native OS dialogs and call the Python
 * worker without having direct access to Node.js APIs.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Open a native directory-picker dialog.
   * @returns {Promise<string|null>} The chosen directory path, or null if
   *   the user cancelled.
   */
  openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),

  /**
   * Open a native file-picker dialog filtered to .ini files.
   * @returns {Promise<string|null>} The chosen file path, or null if the
   *   user cancelled.
   */
  openIniFile: () => ipcRenderer.invoke("dialog:openIniFile"),

  /**
   * Call a method on the Python worker and return a promise resolving to
   * { result, error }.  The error field is null on success.
   *
   * @param {string} method  JSON-RPC method name (e.g. "scan_library_dir")
   * @param {object} params  Method parameters
   * @returns {Promise<{result: any, error: string|null}>}
   */
  call: (method, params) => ipcRenderer.invoke("python:call", { method, params }),
});
