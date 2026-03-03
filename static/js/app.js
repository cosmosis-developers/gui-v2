/**
 * app.js — main application logic
 *
 * Handles:
 *   - Tab switching
 *   - Socket.IO connection (receives available modules & initial pipeline)
 *   - Left sidebar: rendering draggable module cards
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
  });

  socket.on("pipeline_update", (modules) => {
    pipeline.setModules(modules);
  });

  // ── Left sidebar: module library ─────────────────────────────

  function renderModuleLibrary(modules) {
    const list = document.getElementById("module-list");
    list.innerHTML = "";

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
      header.className = "category-toggle expanded";
      header.innerHTML = `<span class="category-chevron"></span>${escHtml(catName)}`;
      header.addEventListener("click", () => {
        const isOpen = header.classList.toggle("expanded");
        body.style.display = isOpen ? "" : "none";
      });

      const body = document.createElement("div");
      body.className = "category-modules";

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
