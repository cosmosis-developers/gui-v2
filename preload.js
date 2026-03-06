/**
 * preload.js — runs in the renderer context with Node integration OFF.
 *
 * Exposes a minimal, safe API surface to the renderer via contextBridge so
 * that the page JavaScript can trigger native OS dialogs without having
 * direct access to Node.js APIs.
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
});
