/**
 * app.js — main application logic
 *
 * Handles:
 *   - Tab switching
 *   - Socket.IO connection (receives available modules & initial pipeline)
 *   - Left sidebar: rendering draggable module cards, "Open Library" directory picker
 *   - Right sidebar: showing details for a selected module
 */
document.addEventListener("DOMContentLoaded", () => {
  // ── Tab switching ────────────────────────────────────────────
  const tabBtns     = document.querySelectorAll(".tab-btn");
  const tabPanels   = document.querySelectorAll(".tab-content");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      tabPanels.forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      const panel = document.getElementById("tab-" + btn.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });

  // ── Pipeline canvas ──────────────────────────────────────────
  const pipeline = new PipelineCanvas("pipeline-canvas-container");

  // ── Socket.IO ────────────────────────────────────────────────
  const socket = io();

  socket.on("connect", () => {
    console.log("[socket] connected:", socket.id);
  });

  socket.on("available_modules", (modules) => {
    renderModuleLibrary(modules);
    setScanStatus("", false);
  });

  socket.on("pipeline_update", (modules) => {
    pipeline.setModules(modules);
  });

  socket.on("scan_error", (data) => {
    setScanStatus("Error: " + (data.message || "unknown error"), true);
  });

  // ── Open Library button ───────────────────────────────────────

  const openLibraryBtn   = document.getElementById("open-library-btn");
  const libraryDirInput  = document.getElementById("library-dir-input");
  const scanStatusEl     = document.getElementById("scan-status");

  openLibraryBtn.addEventListener("click", () => {
    libraryDirInput.value = ""; // reset so same folder can be re-selected
    libraryDirInput.click();
  });

  libraryDirInput.addEventListener("change", () => {
    const files = Array.from(libraryDirInput.files);
    // Keep only module.yaml files
    const yamlFiles = files.filter((f) => f.name === "module.yaml");

    if (yamlFiles.length === 0) {
      setScanStatus("No module.yaml files found in the selected directory.", true);
      return;
    }

    setScanStatus(`Reading ${yamlFiles.length} module.yaml file(s)…`, false);

    // Read all files as text, then send to server for parsing
    Promise.all(
      yamlFiles.map((file) =>
        file.text().then((content) => ({
          path: file.webkitRelativePath || file.name,
          content,
        }))
      )
    ).then((fileList) => {
      setScanStatus(`Scanning ${fileList.length} module.yaml file(s)…`, false);
      socket.emit("scan_library", fileList);
    }).catch((err) => {
      setScanStatus("Failed to read files: " + err.message, true);
    });
  });

  function setScanStatus(msg, isError) {
    if (!msg) {
      scanStatusEl.classList.add("hidden");
      scanStatusEl.textContent = "";
      return;
    }
    scanStatusEl.textContent = msg;
    scanStatusEl.classList.remove("hidden");
    scanStatusEl.classList.toggle("scan-status-error", isError);
  }

  // ── Left sidebar: module library ─────────────────────────────

  function renderModuleLibrary(modules) {
    const list = document.getElementById("module-list");
    list.innerHTML = "";

    if (modules.length === 0) {
      const empty = document.createElement("p");
      empty.className = "no-ports";
      empty.textContent = "No modules loaded. Use \u201cOpen Library\u201d to load a CosmoSIS standard library.";
      list.appendChild(empty);
      return;
    }

    // Group modules by category
    const groups = {};
    modules.forEach((mod) => {
      const cat = mod.category || "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(mod);
    });

    Object.entries(groups).forEach(([catName, mods]) => {
      const section = document.createElement("div");
      section.className = "category-group";

      const header = document.createElement("button");
      header.className = "category-toggle";
      header.innerHTML = `<span class="category-chevron"></span>${escHtml(catName)}`;
      header.addEventListener("click", () => {
        const isOpen = header.classList.toggle("expanded");
        body.style.display = isOpen ? "" : "none";
      });

      const body = document.createElement("div");
      body.className = "category-modules";
      body.style.display = "none";

      mods.forEach((mod) => {
        const card = document.createElement("div");
        card.className   = "module-card";
        card.draggable   = true;
        card.innerHTML   = `
          <div class="module-card-name">${escHtml(mod.name)}</div>
          <div class="module-card-desc">${escHtml(mod.description)}</div>
        `;

        // Drag from sidebar → canvas
        card.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("application/json", JSON.stringify(mod));
          e.dataTransfer.effectAllowed = "copy";
          card.classList.add("dragging");
        });
        card.addEventListener("dragend", () => card.classList.remove("dragging"));

        // Click → show details in right sidebar
        card.addEventListener("click", () => showDetails(mod));

        body.appendChild(card);
      });

      section.appendChild(header);
      section.appendChild(body);
      list.appendChild(section);
    });
  }

  // ── Right sidebar ─────────────────────────────────────────────

  const rightSidebar  = document.getElementById("right-sidebar");
  const detailsTitle  = document.getElementById("details-title");
  const detailsBody   = document.getElementById("details-content");
  const closeBtn      = document.getElementById("close-details");

  closeBtn.addEventListener("click", () => {
    hideDetails();
    // Also deselect in pipeline canvas
    pipeline.deselect();
  });

  // Listen for selection events from the pipeline canvas
  document.addEventListener("pipeline:moduleSelected", (e) => {
    if (e.detail) {
      showDetails(e.detail);
    } else {
      hideDetails();
    }
  });

  function showDetails(mod) {
    if (!mod) { hideDetails(); return; }

    detailsTitle.textContent = mod.name;
    rightSidebar.classList.remove("hidden");

    const inputs  = mod.inputs  || [];
    const outputs = mod.outputs || [];

    detailsBody.innerHTML = `
      <p class="module-detail-desc">${escHtml(mod.description || "")}</p>

      <div class="detail-section">
        <h3>Inputs (${inputs.length})</h3>
        ${inputs.length === 0
          ? '<p class="no-ports">No inputs</p>'
          : inputs.map(portRow("input")).join("")}
      </div>

      <div class="detail-section">
        <h3>Outputs (${outputs.length})</h3>
        ${outputs.length === 0
          ? '<p class="no-ports">No outputs</p>'
          : outputs.map(portRow("output")).join("")}
      </div>
    `;
  }

  function hideDetails() {
    rightSidebar.classList.add("hidden");
  }

  function portRow(type) {
    return (p) => `
      <div class="port-detail ${type}">
        <span class="port-name">${escHtml(p.name)}</span>
        <span class="port-type">${escHtml(p.type)}</span>
        <span class="port-desc">${escHtml(p.description || "")}</span>
      </div>`;
  }

  // ── Utility ───────────────────────────────────────────────────

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
});
