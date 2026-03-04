/**
 * app.js — main application logic
 *
 * Handles:
 *   - Tab switching
 *   - Socket.IO (receives available modules & initial pipeline)
 *   - Left sidebar: module library, "Open Library" directory picker
 *   - Right sidebar: module details with expandable sections and params form
 */
document.addEventListener("DOMContentLoaded", () => {

  // ── Tab switching ────────────────────────────────────────────
  const tabBtns   = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-content");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected","false"); });
      tabPanels.forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      btn.setAttribute("aria-selected","true");
      const panel = document.getElementById("tab-" + btn.dataset.tab);
      if (panel) panel.classList.add("active");
    });
  });

  // ── Pipeline canvas ──────────────────────────────────────────
  const pipeline = new PipelineCanvas("pipeline-canvas-container");

  // ── Socket.IO ────────────────────────────────────────────────
  const socket = io();
  socket.on("connect", () => console.log("[socket] connected:", socket.id));
  socket.on("available_modules", modules => { renderModuleLibrary(modules); setScanStatus("", false); });
  socket.on("pipeline_update",   modules => { pipeline.setModules(modules); setScanStatus("", false); });
  socket.on("scan_error",        data    => setScanStatus("Error: " + (data.message || "unknown error"), true));
  socket.on("pipeline_load_error", data  => setScanStatus("Pipeline load error: " + (data.message || "unknown"), true));

  // ── Open Library button ───────────────────────────────────────
  const openLibraryBtn = document.getElementById("open-library-btn");
  const scanStatusEl   = document.getElementById("scan-status");

  openLibraryBtn.addEventListener("click", () => {
    const dir = prompt(
      "Enter the path to the CosmoSIS standard library directory:",
      ""
    );
    if (dir === null || dir.trim() === "") return; // cancelled
    setScanStatus("Scanning\u2026", false);
    socket.emit("scan_library_dir", { path: dir.trim() });
  });

  // ── Open Pipeline button ──────────────────────────────────────
  const openPipelineBtn = document.getElementById("open-pipeline-btn");

  openPipelineBtn.addEventListener("click", () => {
    const iniPath = prompt(
      "Enter the path to a CosmoSIS pipeline .ini file:",
      ""
    );
    if (iniPath === null || iniPath.trim() === "") return;
    setScanStatus("Loading pipeline\u2026", false);
    socket.emit("load_pipeline_ini", { path: iniPath.trim() });
  });

  function setScanStatus(msg, isError) {
    if (!msg) { scanStatusEl.classList.add("hidden"); scanStatusEl.textContent = ""; return; }
    scanStatusEl.textContent = msg;
    scanStatusEl.classList.remove("hidden");
    scanStatusEl.classList.toggle("scan-status-error", isError);
  }

  // ── Left sidebar: module library ─────────────────────────────
  function renderModuleLibrary(modules) {
    const list = document.getElementById("module-list");
    list.innerHTML = "";
    if (!modules.length) {
      const p = document.createElement("p");
      p.className = "no-ports";
      p.textContent = "No modules loaded. Use \u201cOpen Library\u201d to scan a CosmoSIS standard library.";
      list.appendChild(p);
      return;
    }
    const groups = {};
    modules.forEach(mod => {
      const cat = mod.category || "Other";
      (groups[cat] = groups[cat] || []).push(mod);
    });
    Object.entries(groups).forEach(([catName, mods]) => {
      const section = document.createElement("div");
      section.className = "category-group";
      const header = document.createElement("button");
      header.className = "category-toggle";
      header.innerHTML = `<span class="category-chevron"></span>${escHtml(catName)}`;
      header.addEventListener("click", () => {
        const open = header.classList.toggle("expanded");
        body.style.display = open ? "" : "none";
      });
      const body = document.createElement("div");
      body.className = "category-modules";
      body.style.display = "none";
      mods.forEach(mod => {
        const card = document.createElement("div");
        card.className = "module-card";
        card.draggable = true;
        card.innerHTML = `<div class="module-card-name">${escHtml(mod.name)}</div><div class="module-card-desc">${escHtml(mod.description)}</div>`;
        card.addEventListener("dragstart", e => {
          e.dataTransfer.setData("application/json", JSON.stringify(mod));
          e.dataTransfer.effectAllowed = "copy";
          card.classList.add("dragging");
        });
        card.addEventListener("dragend", () => card.classList.remove("dragging"));
        card.addEventListener("click",   () => showDetails(mod));
        body.appendChild(card);
      });
      section.appendChild(header);
      section.appendChild(body);
      list.appendChild(section);
    });
  }

  // ── Right sidebar ─────────────────────────────────────────────
  const rightSidebar = document.getElementById("right-sidebar");
  const detailsTitle = document.getElementById("details-title");
  const detailsBody  = document.getElementById("details-content");
  const closeBtn     = document.getElementById("close-details");

  /** instanceId of the module currently shown in the sidebar */
  let currentInstanceId = null;

  closeBtn.addEventListener("click", () => { hideDetails(); pipeline.deselect(); });

  document.addEventListener("pipeline:moduleSelected", e => {
    if (e.detail) showDetails(e.detail);
    else          hideDetails();
  });

  /** Re-render the sidebar when a section is toggled in the canvas. */
  document.addEventListener("pipeline:sectionToggled", () => {
    const mod = pipeline.getSelectedModule();
    if (mod && mod.instanceId === currentInstanceId) showDetails(mod);
  });

  function showDetails(mod) {
    if (!mod) { hideDetails(); return; }
    // Always work with the live reference so paramValues are up-to-date
    const live = pipeline.getSelectedModule() || mod;
    currentInstanceId = live.instanceId;
    detailsTitle.textContent = live.name;
    rightSidebar.classList.remove("hidden");
    detailsBody.innerHTML = "";
    detailsBody.appendChild(_buildDetailsContent(live));
  }

  function hideDetails() {
    currentInstanceId = null;
    rightSidebar.classList.add("hidden");
  }

  // ── Right sidebar: detail sections ───────────────────────────

  function _buildDetailsContent(mod) {
    const wrap = document.createElement("div");

    // Description
    if (mod.description) {
      const p = document.createElement("p");
      p.className = "module-detail-desc";
      p.textContent = mod.description;
      wrap.appendChild(p);
    }

    // Inputs & outputs
    _appendPortSection(wrap, mod, "input",  mod.inputs  || []);
    _appendPortSection(wrap, mod, "output", mod.outputs || []);

    // Params form
    const params = mod.params || [];
    if (params.length) wrap.appendChild(_buildParamsForm(mod));

    return wrap;
  }

  function _appendPortSection(wrap, mod, portType, ports) {
    if (!ports.length) return;
    const section = document.createElement("div");
    section.className = "detail-section";
    const h3 = document.createElement("h3");
    h3.textContent = (portType === "input" ? "Inputs" : "Outputs") + ` (${ports.length})`;
    section.appendChild(h3);

    ports.forEach((port, i) => {
      const key      = `${mod.instanceId}|${portType}|${i}`;
      const expanded = pipeline.expandedPorts.has(key);
      const hasItems = port.type === "section" && (port.items || []).length > 0;

      const row = document.createElement("div");
      row.className = "port-detail " + portType + (hasItems ? " expandable-port" : "");

      const nameSpan = document.createElement("span");
      nameSpan.className = "port-name";
      if (hasItems) {
        nameSpan.innerHTML = `<span class="sidebar-chevron">${expanded ? "▼" : "▶"}</span>${escHtml(port.name)}`;
        row.style.cursor = "pointer";
        row.addEventListener("click", () => {
          pipeline.togglePortFromSidebar(mod.instanceId, portType, i);
          // sidebar refreshed via pipeline:sectionToggled → showDetails
        });
      } else {
        nameSpan.textContent = port.name;
      }
      row.appendChild(nameSpan);

      if (port.type) {
        const typeSpan = document.createElement("span");
        typeSpan.className = "port-type";
        typeSpan.textContent = port.type;
        row.appendChild(typeSpan);
      }
      section.appendChild(row);

      // Expanded sub-params
      if (hasItems && expanded) {
        const subWrap = document.createElement("div");
        subWrap.className = "sub-params-list";
        (port.items || []).forEach(item => {
          const sub = document.createElement("div");
          sub.className = "sub-param-row " + portType;
          sub.innerHTML = `<span class="sub-param-name">${escHtml(item.name)}</span>` +
                          (item.type ? `<span class="port-type">${escHtml(item.type)}</span>` : "");
          if (item.description) {
            const desc = document.createElement("span");
            desc.className = "port-desc";
            desc.textContent = item.description;
            sub.appendChild(desc);
          }
          subWrap.appendChild(sub);
        });
        section.appendChild(subWrap);
      }
    });
    wrap.appendChild(section);
  }

  // ── Params form ───────────────────────────────────────────────

  function _buildParamsForm(mod) {
    const section = document.createElement("div");
    section.className = "detail-section";
    const h3 = document.createElement("h3");
    h3.textContent = `Parameters (${mod.params.length})`;
    section.appendChild(h3);

    const form = document.createElement("div");
    form.className = "params-form";

    mod.params.forEach(param => {
      // Resolve current value: stored value → YAML default → empty
      const storedVal = (mod.paramValues || {})[param.name];
      const defVal    = param.default != null ? String(param.default) : "";
      const curVal    = storedVal !== undefined ? String(storedVal) : defVal;

      const row = document.createElement("div");
      row.className = "param-row";

      // Param name button (click to reveal/hide meaning)
      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "param-name-btn";
      nameBtn.title = "Click to show/hide description";
      nameBtn.textContent = param.name;
      row.appendChild(nameBtn);

      // Meaning tooltip (hidden by default)
      const meaning = document.createElement("div");
      meaning.className = "param-meaning hidden";
      meaning.textContent = param.meaning || "(no description)";
      nameBtn.addEventListener("click", () => meaning.classList.toggle("hidden"));

      // Input widget
      const inputWrap = document.createElement("div");
      inputWrap.className = "param-input-wrap";

      const typeStr = (param.type || "").toLowerCase();
      let input;

      if (typeStr === "bool" || typeStr === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.className = "param-checkbox";
        input.checked = ["true","1","yes","on"].includes(curVal.toLowerCase());
        input.addEventListener("change", () => {
          _storeParam(mod, param.name, input.checked);
        });
      } else {
        input = document.createElement("input");
        input.className = "param-input";
        input.value = curVal;
        if (typeStr === "int" || typeStr === "integer") {
          input.type = "number";
          input.step = "1";
          input.placeholder = "integer";
        } else if (typeStr === "real" || typeStr === "float" || typeStr === "double") {
          input.type = "number";
          input.step = "any";
          input.placeholder = "number";
        } else {
          input.type = "text";
          input.placeholder = typeStr || "value";
        }

        const errSpan = document.createElement("span");
        errSpan.className = "param-error hidden";

        input.addEventListener("input", () => {
          const valid = _validateParam(input.value, param.type);
          errSpan.classList.toggle("hidden", valid);
          errSpan.textContent = valid ? "" : `Expected ${param.type}`;
          input.classList.toggle("param-input-invalid", !valid);
          if (valid) _storeParam(mod, param.name, _coerceParam(input.value, param.type));
        });
        inputWrap.appendChild(errSpan);
      }

      inputWrap.insertBefore(input, inputWrap.firstChild);
      row.appendChild(inputWrap);
      row.appendChild(meaning);
      form.appendChild(row);
    });

    section.appendChild(form);
    return section;
  }

  /** Store a param value on the live pipeline module. */
  function _storeParam(mod, paramName, value) {
    const live = pipeline.modules.find(m => m.instanceId === mod.instanceId);
    if (live) {
      if (!live.paramValues) live.paramValues = {};
      live.paramValues[paramName] = value;
    }
  }

  /** Return true if the string value is valid for the given type string. */
  function _validateParam(val, typeStr) {
    if (!val && val !== "0") return true; // empty is OK (param not set)
    const t = (typeStr || "").toLowerCase();
    if (t === "int" || t === "integer") return /^-?\d+$/.test(val.trim());
    if (t === "real" || t === "float" || t === "double")
      return /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(val.trim());
    return true; // str, bool, unknown → always valid
  }

  /** Coerce a string to the appropriate JS type. */
  function _coerceParam(val, typeStr) {
    const t = (typeStr || "").toLowerCase();
    if (t === "int" || t === "integer") return parseInt(val, 10);
    if (t === "real" || t === "float" || t === "double") return parseFloat(val);
    return val;
  }

  // ── Utility ───────────────────────────────────────────────────
  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
});
