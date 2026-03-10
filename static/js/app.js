/**
 * app.js — main application logic
 *
 * Handles:
 *   - Tab switching
 *   - IPC calls to the Python Backend worker
 *   - Left sidebar: module library, "Open Library" / "Open Pipeline" buttons
 *   - Left sidebar: "Prepare Pipeline" / "Run Likelihood" buttons
 *   - Right sidebar: module details with expandable sections, params form,
 *     and per-module pipeline setup output
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

  // ── Python worker bridge ─────────────────────────────────────
  async function pyCall(method, params = {}) {
    if (!window.electronAPI?.call) {
      throw new Error("Python worker not available (running outside Electron).");
    }
    return window.electronAPI.call(method, params);
  }

  // ── Per-module setup output storage ──────────────────────────
  // Key: ini_section name (string), Value: output text (string)
  const modulePrepOutput = new Map();

  // ── Load initial data ─────────────────────────────────────────
  async function loadInitialData() {
    try {
      const [modRes, pipRes] = await Promise.all([
        pyCall("get_modules",  {}),
        pyCall("get_pipeline", {}),
      ]);
      if (modRes.error)  console.error("[get_modules]",  modRes.error);
      else               renderModuleLibrary(modRes.result);
      if (pipRes.error)  console.error("[get_pipeline]", pipRes.error);
      else               pipeline.setModules(pipRes.result);
    } catch (err) {
      console.warn("Initial data load skipped:", err.message);
    }

    // Auto-scan: if the app was launched from a directory that is different
    // from the script directory, scan that launch directory for modules.
    try {
      const scanDir = window.electronAPI?.getStartupScanDir
        ? await window.electronAPI.getStartupScanDir()
        : null;
      if (scanDir) {
        setScanStatus(`Auto-scanning ${scanDir}\u2026`, false);
        const res = await pyCall("scan_library_dir", { path: scanDir });
        if (res.error) setScanStatus("Auto-scan error: " + res.error, true);
        else { renderModuleLibrary(res.result); setScanStatus("", false); }
      }
    } catch (err) {
      console.warn("Startup auto-scan skipped:", err.message);
    }
  }

  loadInitialData();

  // ── Open Library button ───────────────────────────────────────
  const openLibraryBtn = document.getElementById("open-library-btn");
  const scanStatusEl   = document.getElementById("scan-status");

  openLibraryBtn.addEventListener("click", async () => {
    let dir;
    if (window.electronAPI) {
      dir = await window.electronAPI.openDirectory();
      if (!dir) return;
    } else {
      dir = prompt("Enter the path to the CosmoSIS standard library directory:", "");
      if (dir === null || dir.trim() === "") return;
      dir = dir.trim();
    }

    setScanStatus("Scanning\u2026", false);
    try {
      const res = await pyCall("scan_library_dir", { path: dir });
      if (res.error) setScanStatus("Error: " + res.error, true);
      else { renderModuleLibrary(res.result); setScanStatus("", false); }
    } catch (err) {
      setScanStatus("Error: " + err.message, true);
    }
  });

  // ── Open Pipeline button ──────────────────────────────────────
  const openPipelineBtn = document.getElementById("open-pipeline-btn");

  openPipelineBtn.addEventListener("click", async () => {
    let iniPath;
    if (window.electronAPI) {
      iniPath = await window.electronAPI.openIniFile();
      if (!iniPath) return;
    } else {
      iniPath = prompt("Enter the path to a CosmoSIS pipeline .ini file:", "");
      if (iniPath === null || iniPath.trim() === "") return;
      iniPath = iniPath.trim();
    }

    setScanStatus("Loading pipeline\u2026", false);
    try {
      const res = await pyCall("load_pipeline_ini", { path: iniPath });
      if (res.error) {
        setScanStatus("Pipeline load error: " + res.error, true);
      } else {
        // Clear any stale prep output from a previous pipeline.
        modulePrepOutput.clear();
        pipeline.setModules(res.result);
        setScanStatus("", false);
        // Enable Prepare Pipeline now that a file is loaded; reset run button.
        preparePipelineBtn.disabled = false;
        runLikelihoodBtn.disabled   = true;
        setPipelineStatus("", "");
      }
    } catch (err) {
      setScanStatus("Pipeline load error: " + err.message, true);
    }
  });

  function setScanStatus(msg, isError) {
    if (!msg) { scanStatusEl.classList.add("hidden"); scanStatusEl.textContent = ""; return; }
    scanStatusEl.textContent = msg;
    scanStatusEl.classList.remove("hidden");
    scanStatusEl.classList.toggle("scan-status-error", isError);
  }

  // ── Prepare Pipeline button ───────────────────────────────────
  const preparePipelineBtn = document.getElementById("prepare-pipeline-btn");
  const runLikelihoodBtn   = document.getElementById("run-likelihood-btn");
  const pipelineStatusEl   = document.getElementById("pipeline-status");
  const pipelineActionsEl  = document.querySelector(".pipeline-actions");

  preparePipelineBtn.addEventListener("click", async () => {
    setPipelineStatus("Setting up pipeline\u2026", "setup");
    preparePipelineBtn.disabled = true;
    runLikelihoodBtn.disabled   = true;
    pipelineActionsEl.classList.remove("pipeline-ready");

    try {
      const res = await pyCall("prepare_pipeline", {});
      if (res.error) {
        setPipelineStatus(res.error, "error");
        pipelineActionsEl.classList.remove("pipeline-ready");
      } else {
        // Store per-module output (clear stale entries first).
        modulePrepOutput.clear();
        for (const entry of (res.result.modules || [])) {
          if (entry.ini_section) {
            modulePrepOutput.set(entry.ini_section, entry.output || "");
          }
        }
        // Clear any stale actual I/O from a previous run.
        for (const mod of pipeline.modules) {
          delete mod.runStatus;
          delete mod.actualInputs;
          delete mod.actualDefaults;
          delete mod.actualOutputs;
        }
        pipeline._render();
        setPipelineStatus("Pipeline ready \u2014 click \u25b6 Run Likelihood.", "ok");
        runLikelihoodBtn.disabled = false;
        pipelineActionsEl.classList.add("pipeline-ready");
        // Refresh right sidebar if a module is selected.
        const sel = pipeline.getSelectedModule();
        if (sel && currentInstanceId === sel.instanceId) showDetails(sel);
      }
    } catch (err) {
      setPipelineStatus("Error: " + err.message, "error");
      pipelineActionsEl.classList.remove("pipeline-ready");
    } finally {
      preparePipelineBtn.disabled = false;
    }
  });

  // ── Run Likelihood button ─────────────────────────────────────
  // (stays disabled until prepare_pipeline succeeds)
  runLikelihoodBtn.addEventListener("click", async () => {
    setPipelineStatus("Running likelihood\u2026", "run");
    runLikelihoodBtn.disabled = true;

    try {
      const res = await pyCall("run_likelihood", {});
      if (res.error) {
        setPipelineStatus(res.error, "error");
        runLikelihoodBtn.disabled = false;
      } else {
        // Stamp every module with run-ok state.
        for (const mod of pipeline.modules) {
          mod.runStatus = "ok";
        }

        // Store per-module actual I/O and push it onto the live module objects.
        for (const entry of (res.result.modules || [])) {
          if (!entry.ini_section) continue;
          const mod = pipeline.modules.find(m => m.ini_section === entry.ini_section);
          if (mod) {
            mod.actualInputs   = entry.actual_inputs   || [];
            mod.actualDefaults = entry.actual_defaults || [];
            mod.actualOutputs  = entry.actual_outputs  || [];
          }
        }

        pipeline._render();
        setPipelineStatus("Likelihood run complete.", "ok");
        runLikelihoodBtn.disabled = false;

        // Populate the Results tab with DataBlock contents.
        renderResultsTab(res.result.block_contents || []);

        // Refresh right sidebar if a module is currently selected.
        const sel = pipeline.getSelectedModule();
        if (sel && currentInstanceId === sel.instanceId) showDetails(sel);
      }
    } catch (err) {
      setPipelineStatus("Error: " + err.message, "error");
      runLikelihoodBtn.disabled = false;
    }
  });

  // ── Results tab ───────────────────────────────────────────────
  const resultsPlaceholder = document.getElementById("results-placeholder");
  const resultsTree        = document.getElementById("results-tree");
  const resultsDetail      = document.getElementById("results-detail");
  const resultsDetailTitle = document.getElementById("results-detail-title");
  const resultsDetailBody  = document.getElementById("results-detail-body");
  const resultsDetailClose = document.getElementById("results-detail-close");

  resultsDetailClose.addEventListener("click", () => {
    resultsDetail.classList.add("hidden");
  });

  /**
   * Populate the Results tab with the DataBlock contents returned by
   * run_likelihood.  Each section is rendered as a collapsible group;
   * clicking a value row shows its full content in the detail pane.
   *
   * @param {Array} sections  Array of {name, values} from worker.py.
   */
  function renderResultsTab(sections) {
    resultsTree.innerHTML = "";

    if (!sections.length) {
      resultsPlaceholder.classList.remove("hidden");
      resultsTree.classList.add("hidden");
      resultsDetail.classList.add("hidden");
      return;
    }

    resultsPlaceholder.classList.add("hidden");
    resultsTree.classList.remove("hidden");

    sections.forEach(sec => {
      const group   = document.createElement("div");
      group.className = "results-section";

      const header  = document.createElement("button");
      header.type   = "button";
      header.className = "results-section-header";
      header.innerHTML =
        `<span class="results-chevron"></span>` +
        `<span class="results-section-name">${escHtml(sec.name)}</span>` +
        `<span class="results-section-count">${sec.values.length}</span>`;

      const body    = document.createElement("div");
      body.className = "results-section-body";
      body.style.display = "none";

      header.addEventListener("click", () => {
        const open = header.classList.toggle("expanded");
        body.style.display = open ? "" : "none";
      });

      (sec.values || []).forEach(val => {
        const row = document.createElement("div");
        row.className = "results-value-row";

        const nameSpan  = document.createElement("span");
        nameSpan.className = "results-value-name";
        nameSpan.textContent = val.name;

        const typeSpan  = document.createElement("span");
        typeSpan.className = "results-value-type";
        typeSpan.textContent = val.dtype + (val.shape ? ` [${val.shape}]` : "");

        const valueSpan = document.createElement("span");
        valueSpan.className = "results-value-scalar";
        if (val.scalar !== null && val.scalar !== undefined) {
          valueSpan.textContent = val.scalar;
        } else if (val.preview) {
          const more = val.n_elements > val.preview.length;
          valueSpan.textContent = "[" + val.preview.join(", ") + (more ? ", …" : "") + "]";
        }

        row.appendChild(nameSpan);
        row.appendChild(typeSpan);
        row.appendChild(valueSpan);

        // Clicking a value row opens the detail pane.
        row.addEventListener("click", () => {
          resultsDetailTitle.textContent = `${sec.name} / ${val.name}`;
          let content = `section: ${sec.name}\nname:    ${val.name}\ntype:    ${val.dtype}`;
          if (val.shape) content += `\nshape:   ${val.shape}  (${val.n_elements} elements)`;
          if (val.scalar !== null && val.scalar !== undefined) {
            content += `\nvalue:   ${val.scalar}`;
          } else if (val.preview) {
            const more = val.n_elements > val.preview.length;
            content += `\npreview: [${val.preview.join(", ")}${more ? ", …" : ""}]`;
            if (more) content += `\n(first ${val.preview.length} of ${val.n_elements} elements)`;
          }
          resultsDetailBody.textContent = content;
          resultsDetail.classList.remove("hidden");
          document.querySelectorAll(".results-value-row.selected")
            .forEach(r => r.classList.remove("selected"));
          row.classList.add("selected");
        });

        body.appendChild(row);
      });

      group.appendChild(header);
      group.appendChild(body);
      resultsTree.appendChild(group);
    });
  }

  function setPipelineStatus(msg, kind) {
    const spinner = pipelineStatusEl.querySelector(".pipeline-status-spinner");
    const textEl  = document.getElementById("pipeline-status-text");
    pipelineStatusEl.className = "pipeline-status";
    if (!msg) { pipelineStatusEl.classList.add("hidden"); return; }
    if (textEl) textEl.textContent = msg;
    if (kind === "error")       pipelineStatusEl.classList.add("pipeline-status-error");
    else if (kind === "ok")     pipelineStatusEl.classList.add("pipeline-status-ok");
    else if (kind === "setup")  pipelineStatusEl.classList.add("pipeline-status-setup");
    else if (kind === "run")    pipelineStatusEl.classList.add("pipeline-status-run");
    if (spinner) spinner.classList.toggle("hidden", kind !== "setup" && kind !== "run");
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

  let currentInstanceId = null;

  closeBtn.addEventListener("click", () => { hideDetails(); pipeline.deselect(); });

  document.addEventListener("pipeline:moduleSelected", e => {
    if (e.detail) showDetails(e.detail);
    else          hideDetails();
  });

  document.addEventListener("pipeline:sectionToggled", () => {
    const mod = pipeline.getSelectedModule();
    if (mod && mod.instanceId === currentInstanceId) showDetails(mod);
  });

  function showDetails(mod) {
    if (!mod) { hideDetails(); return; }
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

    if (mod.description) {
      const p = document.createElement("p");
      p.className = "module-detail-desc";
      p.textContent = mod.description;
      wrap.appendChild(p);
    }

    // After a successful run, show actual I/O from the DataBlock.
    // Otherwise fall back to the YAML-declared inputs/outputs.
    const hasActual = mod.actualInputs || mod.actualDefaults || mod.actualOutputs;
    if (hasActual) {
      _appendStaticPortSection(wrap, "input",         mod.actualInputs   || [], "Actual Inputs");
      _appendStaticPortSection(wrap, "input-default", mod.actualDefaults || [], "Default Inputs");
      _appendStaticPortSection(wrap, "output",        mod.actualOutputs  || [], "Actual Outputs");
    } else {
      _appendPortSection(wrap, mod, "input",  mod.inputs  || []);
      _appendPortSection(wrap, mod, "output", mod.outputs || []);
    }

    const params = mod.params || [];
    if (params.length) wrap.appendChild(_buildParamsForm(mod));

    // Show per-module pipeline setup output when available.
    const sectionName = mod.ini_section;
    if (sectionName && modulePrepOutput.has(sectionName)) {
      const output = modulePrepOutput.get(sectionName);
      if (output) wrap.appendChild(_buildSetupOutputSection(output));
    }

    return wrap;
  }

  function _buildSetupOutputSection(outputText) {
    const section = document.createElement("div");
    section.className = "detail-section";
    const h3 = document.createElement("h3");
    h3.textContent = "Setup Output";
    section.appendChild(h3);
    const pre = document.createElement("pre");
    pre.className = "setup-output-pre";
    pre.textContent = outputText;
    section.appendChild(pre);
    return section;
  }

  /**
   * Render a static (non-interactive) port section for actual I/O.
   *
   * Unlike _appendPortSection, this function does not link to the pipeline
   * canvas expand/collapse state — items are always shown inline.
   *
   * @param {HTMLElement} wrap        - Parent element to append into.
   * @param {string}      displayClass - CSS class for port rows ("input",
   *                                    "input-default", "output", …).
   * @param {Array}       ports       - Array of port objects from the backend.
   * @param {string}      label       - Section heading text.
   */
  function _appendStaticPortSection(wrap, displayClass, ports, label) {
    if (!ports.length) return;
    const section = document.createElement("div");
    section.className = "detail-section";
    const h3 = document.createElement("h3");
    h3.textContent = `${label} (${ports.length})`;
    section.appendChild(h3);

    ports.forEach(port => {
      const row = document.createElement("div");
      row.className = `port-detail ${displayClass}`;

      const nameSpan = document.createElement("span");
      nameSpan.className = "port-name";
      nameSpan.textContent = port.name;
      row.appendChild(nameSpan);

      if (port.type) {
        const typeSpan = document.createElement("span");
        typeSpan.className = "port-type";
        typeSpan.textContent = port.type;
        row.appendChild(typeSpan);
      }
      section.appendChild(row);

      // Always show items inline (no expand/collapse for actual I/O).
      const items = port.type === "section" ? (port.items || []) : [];
      if (items.length) {
        const subWrap = document.createElement("div");
        subWrap.className = "sub-params-list";
        items.forEach(item => {
          const sub = document.createElement("div");
          sub.className = `sub-param-row ${displayClass}`;
          sub.innerHTML = `<span class="sub-param-name">${escHtml(item.name)}</span>` +
                          (item.type ? `<span class="port-type">${escHtml(item.type)}</span>` : "");
          subWrap.appendChild(sub);
        });
        section.appendChild(subWrap);
      }
    });

    wrap.appendChild(section);
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
      const storedVal = (mod.paramValues || {})[param.name];
      const defVal    = param.default != null ? String(param.default) : "";
      const curVal    = storedVal !== undefined ? String(storedVal) : defVal;

      const row = document.createElement("div");
      row.className = "param-row";

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "param-name-btn";
      nameBtn.title = "Click to show/hide description";
      nameBtn.textContent = param.name;
      row.appendChild(nameBtn);

      const meaning = document.createElement("div");
      meaning.className = "param-meaning hidden";
      meaning.textContent = param.meaning || "(no description)";
      nameBtn.addEventListener("click", () => meaning.classList.toggle("hidden"));

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
          input.type        = "number";
          input.step        = "1";
          input.placeholder = "integer";
        } else if (typeStr === "real" || typeStr === "float" || typeStr === "double") {
          input.type        = "number";
          input.step        = "any";
          input.placeholder = "number";
        } else {
          input.type        = "text";
          input.placeholder = typeStr || "value";
        }

        const errSpan = document.createElement("span");
        errSpan.className = "param-error hidden";

        // Debounced Python update — fires 400 ms after the last keystroke.
        const debouncedPyUpdate = _debounce((section, key, val) => {
          pyCall("update_param", { ini_section: section, key, value: val })
            .catch(err => console.warn("[update_param]", err));
        }, 400);

        input.addEventListener("input", () => {
          const valid = _validateParam(input.value, param.type);
          errSpan.classList.toggle("hidden", valid);
          errSpan.textContent = valid ? "" : `Expected ${param.type}`;
          input.classList.toggle("param-input-invalid", !valid);
          if (valid) {
            const coerced = _coerceParam(input.value, param.type);
            _storeParam(mod, param.name, coerced);
            const live = pipeline.modules.find(m => m.instanceId === mod.instanceId);
            if (live && live.ini_section) {
              debouncedPyUpdate(live.ini_section, param.name, String(coerced));
            }
          }
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
    if (!val && val !== "0") return true;
    const t = (typeStr || "").toLowerCase();
    if (t === "int" || t === "integer") return /^-?\d+$/.test(val.trim());
    if (t === "real" || t === "float" || t === "double")
      return /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(val.trim());
    return true;
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

  /** Return a debounced version of fn that fires delay ms after the last call. */
  function _debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }
});
