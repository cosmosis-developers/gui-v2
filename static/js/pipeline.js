/**
 * pipeline.js — SVG pipeline canvas  (v3)
 *
 * New in this version
 * -------------------
 *  • Dynamic box widths (canvas-based text measurement, minimum enforced)
 *  • Section port boxes connect to the MODULE CENTRE with a bezier curve
 *    (no more flat horizontal dashed lines)
 *  • When a module is selected, preceding modules that supply its inputs
 *    show their matching output boxes; arcs flow from those output boxes
 *    to the selected module's input boxes
 *  • Section boxes are click-to-expand; individual parameter sub-boxes
 *    appear in a new colour beside the section box
 *  • Pipeline is centred horizontally so there is always room for sub-boxes
 */
class PipelineCanvas {
  // ── Layout constants ──────────────────────────────────────────────
  static SAMPLER_INDEX = 0;

  static MH   = 58;   // module box height
  static MS   = 130;  // vertical gap between module boxes
  static PADV = 100;  // top / bottom canvas padding (extra room for expanded sub-params)
  static PADH = 40;   // minimum left / right canvas padding

  // Section (outer) port boxes
  static PH      = 22;  // section box height
  static PG      = 4;   // vertical gap between section boxes
  static PO      = 18;  // gap: module edge ↔ section box near-side
  static PW_MIN  = 90;  // minimum section box width
  static PW_PAD  = 18;  // total inner horizontal text padding

  // Sub-parameter boxes (shown when a section is expanded)
  static SPH     = 18;  // sub-param box height
  static SPG     = 3;   // vertical gap between sub-param boxes
  static SPO     = 16;  // gap: section box far-side ↔ sub-param box near-side
  static SPW_MIN = 70;  // minimum sub-param box width
  static SPW_PAD = 12;  // total inner horizontal text padding

  // Module box
  static MW_MIN  = 120; // minimum module box width
  static MW_PAD  = 24;  // total inner horizontal text padding

  static MIN_BULGE = 20; // minimum bezier bulge (pixels)
  static FONT_FAMILY = '-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';

  // ── Constructor ───────────────────────────────────────────────────

  constructor(containerId) {
    this.container     = document.getElementById(containerId);
    this.modules       = [];
    this.selectedId    = null;
    this.dropIndex     = -1;
    /** Set of "instanceId|input|idx" / "instanceId|output|idx" keys */
    this.expandedPorts = new Set();
    this._canvasDrag   = null;
    this._textCtx      = null; // lazy canvas-2D for text measurement
    this._initSVG();
  }

  // ── Public API ────────────────────────────────────────────────────

  setModules(modules) {
    this.modules = modules.map((m, i) => ({
      ...m,
      instanceId:  m.instanceId  || `${m.id}_${i}`,
      paramValues: m.paramValues || {},
    }));
    this._render();
  }

  deselect() {
    this._select(null);
  }

  getSelectedModule() {
    return this.selectedId
      ? (this.modules.find(m => m.instanceId === this.selectedId) || null)
      : null;
  }

  /** Called from the sidebar when the user expands/collapses a section there. */
  togglePortFromSidebar(instanceId, portType, portIdx) {
    const key         = `${instanceId}|${portType}|${portIdx}`;
    const wasExpanded = this.expandedPorts.has(key);

    // Close any other open sections of the same type for this module.
    for (const k of [...this.expandedPorts]) {
      if (k.startsWith(`${instanceId}|${portType}|`)) {
        this.expandedPorts.delete(k);
      }
    }

    if (!wasExpanded) this.expandedPorts.add(key);
    this._render();
  }

  // ── Text measurement ──────────────────────────────────────────────

  _textWidth(text, fontSize, bold) {
    if (!this._textCtx)
      this._textCtx = document.createElement("canvas").getContext("2d");
    const ff = PipelineCanvas.FONT_FAMILY;
    this._textCtx.font = `${bold ? "600" : "400"} ${fontSize}px ${ff}`;
    return this._textCtx.measureText(String(text)).width;
  }

  _sectionBoxWidth(name) {
    const { PW_MIN, PW_PAD } = PipelineCanvas;
    return Math.max(PW_MIN, Math.ceil(this._textWidth(name, 10) + PW_PAD));
  }

  _subBoxWidth(name) {
    const { SPW_MIN, SPW_PAD } = PipelineCanvas;
    return Math.max(SPW_MIN, Math.ceil(this._textWidth(name, 9) + SPW_PAD));
  }

  _moduleBoxWidth(name) {
    const { MW_MIN, MW_PAD } = PipelineCanvas;
    return Math.max(MW_MIN, Math.ceil(this._textWidth(name, 13, true) + MW_PAD));
  }

  /** Maximum section-box width across every port in the current pipeline. */
  _maxSectionWidth() {
    let max = PipelineCanvas.PW_MIN;
    for (const m of this.modules)
      for (const p of [...(m.inputs || []), ...(m.outputs || [])])
        max = Math.max(max, this._sectionBoxWidth(p.name));
    return max;
  }

  /** Maximum module-box width across every module in the pipeline. */
  _maxModWidth() {
    let max = PipelineCanvas.MW_MIN;
    for (const m of this.modules)
      max = Math.max(max, this._moduleBoxWidth(m.name));
    return max;
  }

  // ── Coordinate helpers ────────────────────────────────────────────

  /**
   * X of the left edge of every module box.
   *
   * Always reserves room for sub-param boxes on the left so the pipeline
   * does not shift when a section is expanded.
   */
  _modX() {
    const { PADH, PO, SPO, SPW_MIN } = PipelineCanvas;
    return PADH + SPW_MIN + SPO + this._maxSectionWidth() + PO;
  }

  _modY(i) {
    const { PADV, MH, MS } = PipelineCanvas;
    return PADV + i * (MH + MS);
  }

  _svgWidth() {
    const natural = this._modX() * 2 + this._maxModWidth();
    return Math.max(natural, this.container.clientWidth || 700);
  }

  _svgHeight() {
    const { PADV, MH, MS } = PipelineCanvas;
    const n = this.modules.length || 1;
    const natural = PADV * 2 + n * MH + (n - 1) * MS;
    return Math.max(natural, this.container.clientHeight || 400);
  }

  // ── Render orchestration ──────────────────────────────────────────

  _render() {
    while (this.svg.childNodes.length > 1)
      this.svg.removeChild(this.svg.lastChild);

    const w = this._svgWidth();
    const h = this._svgHeight();
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.setAttribute("width",   w);
    this.svg.setAttribute("height",  h);

    this._appendBg(w, h);

    let selIdx = -1;
    if (this.selectedId)
      selIdx = this.modules.findIndex(m => m.instanceId === this.selectedId);

    const srcOutPos = selIdx >= 0
      ? this._computeSourceOutputPositions(selIdx)
      : {};

    if (selIdx >= 0) this._appendPortEdges(selIdx, srcOutPos);
    this._appendConnections();
    this.modules.forEach((m, i) => {
      this._appendModule(m, i);
      if (selIdx >= 0 && i < selIdx && srcOutPos[i])
        this._appendSourceOutputBoxes(m, i, srcOutPos[i]);
    });
    if (selIdx >= 0) this._appendPorts(this.modules[selIdx], selIdx);
    if (this.dropIndex >= 0) this._appendDropIndicator(this.dropIndex);
  }

  // ── Source-output position computation ───────────────────────────

  _computeSourceOutputPositions(selIdx) {
    const sel    = this.modules[selIdx];
    const inputs = sel.inputs || [];
    const { MH, PH, PG, PO } = PipelineCanvas;

    const matchMap = {};
    inputs.forEach(input => {
      for (let j = selIdx - 1; j >= 0; j--) {
        const src = this.modules[j];
        if (!(src.outputs || []).some(o => o.name === input.name)) continue;
        if (!matchMap[j]) matchMap[j] = [];
        if (!matchMap[j].includes(input.name)) matchMap[j].push(input.name);
        break;
      }
    });

    const result = {};
    Object.entries(matchMap).forEach(([jStr, names]) => {
      const j      = parseInt(jStr);
      const srcMod = this.modules[j];
      const mw     = this._moduleBoxWidth(srcMod.name);
      const portX  = this._modX() + mw + PO;
      const totalH = names.length * (PH + PG) - PG;
      const startY = this._modY(j) + (MH - totalH) / 2;
      result[j] = names.map((name, k) => ({
        name,
        portX,
        portY: startY + k * (PH + PG),
        cy:    startY + k * (PH + PG) + PH / 2,
        portW: this._sectionBoxWidth(name),
      }));
    });
    return result;
  }

  // ── SVG element builders ──────────────────────────────────────────

  _appendBg(w, h) {
    const r = this._el("rect");
    r.setAttribute("width",  w);
    r.setAttribute("height", h);
    r.setAttribute("fill",   "#f1f5f9");
    r.setAttribute("class",  "pipeline-bg");
    this.svg.appendChild(r);
  }

  _appendConnections() {
    const cx  = this._modX() + this._maxModWidth() / 2;
    const { MH } = PipelineCanvas;
    for (let i = 0; i < this.modules.length - 1; i++) {
      const y1 = this._modY(i) + MH;
      const y2 = this._modY(i + 1) - 6;
      const el = this._el("line");
      el.setAttribute("x1",          cx);
      el.setAttribute("y1",          y1);
      el.setAttribute("x2",          cx);
      el.setAttribute("y2",          y2);
      el.setAttribute("stroke",       "#94a3b8");
      el.setAttribute("stroke-width", "2");
      el.setAttribute("marker-end",   "url(#arr-grey)");
      this.svg.appendChild(el);
    }
  }

  _appendModule(module, index) {
    const mx   = this._modX();
    const my   = this._modY(index);
    const mw   = this._moduleBoxWidth(module.name);
    const { MH } = PipelineCanvas;
    const id   = module.instanceId;
    const sel  = id === this.selectedId;
    const perm = !!module.permanent;
    const isDragging = this._canvasDrag && this._canvasDrag.id === id && this._canvasDrag.moved;

    const g = this._el("g");
    g.setAttribute("class",   "module-group");
    g.setAttribute("data-id", id);
    if (isDragging) g.setAttribute("opacity", "0.4");

    const rect = this._el("rect");
    rect.setAttribute("x",      mx);
    rect.setAttribute("y",      my);
    rect.setAttribute("width",  mw);
    rect.setAttribute("height", MH);
    rect.setAttribute("rx",     "8");
    let cls = "module-rect";
    if (perm) cls += " permanent";
    if (sel)  cls += " selected";
    rect.setAttribute("class", cls);
    g.appendChild(rect);

    const text = this._el("text");
    text.setAttribute("x",                 mx + mw / 2);
    text.setAttribute("y",                 my + MH / 2);
    text.setAttribute("text-anchor",       "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("class",             "module-text");
    text.textContent = module.name;
    g.appendChild(text);

    if (!perm) {
      const rm = this._el("text");
      rm.setAttribute("x",           mx + mw - 9);
      rm.setAttribute("y",           my + 16);
      rm.setAttribute("text-anchor", "middle");
      rm.setAttribute("class",       "module-remove");
      rm.textContent = "×";
      rm.addEventListener("click", e => {
        e.stopPropagation();
        this._removeModule(id);
      });
      g.appendChild(rm);
    }

    g.addEventListener("mousedown", e => this._onModuleMouseDown(e, id, index, perm));
    g.addEventListener("click", e => {
      e.stopPropagation();
      if (!this._canvasDrag || !this._canvasDrag.moved) this._select(id);
    });
    this.svg.appendChild(g);
  }

  _appendSourceOutputBoxes(srcMod, srcIdx, positions) {
    const { MH, PH } = PipelineCanvas;
    const mx = this._modX();
    const mw = this._moduleBoxWidth(srcMod.name);
    const my = this._modY(srcIdx);

    positions.forEach(({ name, portX, portY, cy, portW }) => {
      const conn = this._makeBezierConnector(mx + mw, my + MH / 2, portX, cy, "right");
      this.svg.appendChild(conn);
      this.svg.appendChild(this._makePortRect(portX, portY, portW, "output-port"));
      this.svg.appendChild(this._makePortLabel(portX, portY, portW, PH, name));
    });
  }

  _appendPorts(module, index) {
    const mx = this._modX();
    const my = this._modY(index);
    const mw = this._moduleBoxWidth(module.name);
    const { MH, PH, PG, PO, SPH, SPG, SPO } = PipelineCanvas;
    const id = module.instanceId;

    const renderSection = (port, i, portType) => {
      const isInput  = portType === "input";
      const allPorts = isInput ? (module.inputs || []) : (module.outputs || []);
      const pw       = this._sectionBoxWidth(port.name);
      const totalH   = allPorts.length * (PH + PG) - PG;
      const startY   = my + (MH - totalH) / 2;
      const portY    = startY + i * (PH + PG);
      const cy       = portY + PH / 2;
      const portX    = isInput ? mx - PO - pw : mx + mw + PO;
      const key      = `${id}|${portType}|${i}`;
      const hasItems = port.type === "section" && (port.items || []).length > 0;
      const expanded = hasItems && this.expandedPorts.has(key);

      // Straight dashed connector between port and module.
      // Input: right edge of section → left edge of module.
      // Output: right edge of module → left edge of section.
      const conn = this._el("path");
      conn.setAttribute("fill",  "none");
      conn.setAttribute("class", "port-connector");
      conn.setAttribute("d", isInput
        ? `M ${portX + pw} ${cy} L ${mx} ${my + MH / 2}`
        : `M ${mx + mw} ${my + MH / 2} L ${portX} ${cy}`);
      this.svg.appendChild(conn);

      const portCls = (isInput ? "input-port" : "output-port") +
                      (hasItems ? " section-port" : "");
      const rect = this._makePortRect(portX, portY, pw, portCls);
      if (hasItems) {
        rect.style.cursor = "pointer";
        rect.addEventListener("click", e => {
          e.stopPropagation();
          this._toggleSection(id, portType, i);
        });
      }
      this.svg.appendChild(rect);

      if (hasItems) {
        const ch = this._el("text");
        ch.setAttribute("x",                isInput ? portX + 8 : portX + pw - 8);
        ch.setAttribute("y",                portY + PH / 2);
        ch.setAttribute("dominant-baseline","middle");
        ch.setAttribute("text-anchor",      "middle");
        ch.setAttribute("class",            "port-chevron");
        ch.setAttribute("pointer-events",   "none");
        ch.textContent = expanded ? "▼" : "▶";
        this.svg.appendChild(ch);
      }

      const labelInset = hasItems ? 12 : 0;
      const lx = isInput ? portX + labelInset : portX;
      const lw = pw - labelInset;
      this.svg.appendChild(this._makePortLabel(lx, portY, lw, PH, port.name));

      if (expanded) {
        const items     = port.items || [];
        const subTotalH = items.length * (SPH + SPG) - SPG;
        const subStartY = cy - subTotalH / 2;

        items.forEach((item, k) => {
          const spw  = this._subBoxWidth(item.name);
          const subX = isInput ? portX - SPO - spw : portX + pw + SPO;
          const subY = subStartY + k * (SPH + SPG);
          const subCY= subY + SPH / 2;

          // Straight dashed connector between section centre and sub-param.
          // Input:  right edge of sub-param → left edge of section.
          // Output: right edge of section  → left edge of sub-param.
          const subConn = this._el("path");
          subConn.setAttribute("fill",  "none");
          subConn.setAttribute("class", "sub-connector");
          subConn.setAttribute("d", isInput
            ? `M ${subX + spw} ${subCY} L ${portX} ${cy}`
            : `M ${portX + pw}  ${cy}   L ${subX}  ${subCY}`);
          this.svg.appendChild(subConn);

          const subRect = this._makePortRect(subX, subY, spw,
                            isInput ? "input-sub-port" : "output-sub-port");
          subRect.setAttribute("height", String(SPH));
          subRect.setAttribute("rx",     "3");
          this.svg.appendChild(subRect);

          this.svg.appendChild(this._makeSubLabel(subX, subY, spw, SPH, item.name));
        });
      }
    };

    (module.inputs  || []).forEach((p, i) => renderSection(p, i, "input"));
    (module.outputs || []).forEach((p, i) => renderSection(p, i, "output"));
  }

  _appendPortEdges(selIdx, srcOutPos) {
    const sel    = this.modules[selIdx];
    const inputs = sel.inputs || [];
    if (!inputs.length) return;

    const { MH, PH, PG, PO } = PipelineCanvas;
    const mx = this._modX();
    const my = this._modY(selIdx);
    const mw = this._moduleBoxWidth(sel.name);

    const inTotalH = inputs.length * (PH + PG) - PG;
    const inStartY = my + (MH - inTotalH) / 2;

    inputs.forEach((input, i) => {
      const inPW    = this._sectionBoxWidth(input.name);
      const inPortX = mx - PO - inPW;
      const inCY    = inStartY + i * (PH + PG) + PH / 2;

      for (let j = selIdx - 1; j >= 0; j--) {
        if (!srcOutPos[j]) continue;
        const srcBox = srcOutPos[j].find(b => b.name === input.name);
        if (!srcBox) continue;

        // Arc: bottom-centre of source output box → left edge of selected input box.
        // Exits going downward then sweeps left to arrive horizontally at the input.
        const srcBotX = srcBox.portX + srcBox.portW / 2;
        const srcBotY = srcBox.portY + PH;
        const dy      = inCY - srcBotY;
        const d = [
          `M ${srcBotX} ${srcBotY}`,
          `C ${srcBotX} ${srcBotY + dy * 0.5},`,
          `  ${inPortX - 40} ${inCY},`,
          `  ${inPortX} ${inCY}`,
        ].join(" ");

        const path = this._el("path");
        path.setAttribute("d",            d);
        path.setAttribute("class",        "port-edge");
        path.setAttribute("fill",         "none");
        path.setAttribute("stroke",       "#3b82f6");
        path.setAttribute("stroke-width", "1.5");
        path.setAttribute("opacity",      "0.75");
        path.setAttribute("marker-end",   "url(#arr-blue)");
        this.svg.appendChild(path);
        break;
      }
    });
  }

  _appendDropIndicator(index) {
    const { MH, MS } = PipelineCanvas;
    const clamped = Math.max(PipelineCanvas.SAMPLER_INDEX + 1,
                             Math.min(index, this.modules.length));
    const y = clamped < this.modules.length
      ? this._modY(clamped) - MS / 2
      : this._modY(this.modules.length - 1) + MH + MS / 2;

    const mx = this._modX();
    const mw = this._maxModWidth();
    const line = this._el("line");
    line.setAttribute("x1",               mx - 22);
    line.setAttribute("y1",               y);
    line.setAttribute("x2",               mx + mw + 22);
    line.setAttribute("y2",               y);
    line.setAttribute("class",            "insertion-indicator");
    line.setAttribute("stroke",           "#3b82f6");
    line.setAttribute("stroke-width",     "2.5");
    line.setAttribute("stroke-dasharray", "6 3");
    this.svg.appendChild(line);
  }

  // ── SVG element factories ─────────────────────────────────────────

  _makeBezierConnector(x1, y1, x2, y2, side) {
    const span  = Math.abs(x2 - x1);
    const bulge = Math.max(PipelineCanvas.MIN_BULGE, span * 0.5);
    const sign  = side === "right" ? 1 : -1;
    const cp1x  = x1 + sign * bulge;
    const cp2x  = x2 + sign * bulge;
    const d     = `M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}`;
    const el    = this._el("path");
    el.setAttribute("d",     d);
    el.setAttribute("fill",  "none");
    el.setAttribute("class", "port-connector");
    return el;
  }

  _makePortRect(x, y, width, cls) {
    const { PH } = PipelineCanvas;
    const el = this._el("rect");
    el.setAttribute("x",      x);
    el.setAttribute("y",      y);
    el.setAttribute("width",  width);
    el.setAttribute("height", PH);
    el.setAttribute("rx",     "4");
    el.setAttribute("class",  `port-rect ${cls}`);
    return el;
  }

  _makePortLabel(portX, portY, portW, portH, name) {
    const el = this._el("text");
    el.setAttribute("x",                portX + portW / 2);
    el.setAttribute("y",                portY + portH / 2);
    el.setAttribute("text-anchor",      "middle");
    el.setAttribute("dominant-baseline","middle");
    el.setAttribute("class",            "port-label");
    el.textContent = name;
    return el;
  }

  _makeSubLabel(portX, portY, portW, portH, name) {
    const el = this._el("text");
    el.setAttribute("x",                portX + portW / 2);
    el.setAttribute("y",                portY + portH / 2);
    el.setAttribute("text-anchor",      "middle");
    el.setAttribute("dominant-baseline","middle");
    el.setAttribute("class",            "sub-label");
    el.textContent = name;
    return el;
  }

  _el(tag) {
    return document.createElementNS("http://www.w3.org/2000/svg", tag);
  }

  // ── Selection & mutation ──────────────────────────────────────────

  _select(id) {
    this.selectedId = id;
    this.expandedPorts.clear();
    this._render();
    const module = id
      ? (this.modules.find(m => m.instanceId === id) || null)
      : null;
    document.dispatchEvent(
      new CustomEvent("pipeline:moduleSelected", { detail: module })
    );
  }

  _removeModule(id) {
    const idx = this.modules.findIndex(m => m.instanceId === id);
    if (idx <= PipelineCanvas.SAMPLER_INDEX) return;
    this.modules.splice(idx, 1);
    if (this.selectedId === id) {
      this.selectedId = null;
      document.dispatchEvent(
        new CustomEvent("pipeline:moduleSelected", { detail: null })
      );
    }
    this._render();
  }

  _toggleSection(instanceId, portType, portIdx) {
    const key         = `${instanceId}|${portType}|${portIdx}`;
    const wasExpanded = this.expandedPorts.has(key);

    // Close any other open sections of the same type for this module
    // (input sections are independent from output sections).
    for (const k of [...this.expandedPorts]) {
      if (k.startsWith(`${instanceId}|${portType}|`)) {
        this.expandedPorts.delete(k);
      }
    }

    // If the section was not already open, open it now.
    if (!wasExpanded) this.expandedPorts.add(key);

    this._render();
    document.dispatchEvent(new CustomEvent("pipeline:sectionToggled", {
      detail: { instanceId, portType, portIdx, expanded: this.expandedPorts.has(key) },
    }));
  }

  // ── Canvas drag-to-reorder ────────────────────────────────────────

  _onModuleMouseDown(e, id, index, perm) {
    if (e.button !== 0 || perm) return;
    if (e.target.classList.contains("module-remove")) return;
    e.preventDefault();
    e.stopPropagation();
    this._canvasDrag = { id, fromIdx: index, startY: e.clientY, moved: false };
  }

  _onCanvasMouseMove(e) {
    if (!this._canvasDrag) return;
    if (Math.abs(e.clientY - this._canvasDrag.startY) > 5)
      this._canvasDrag.moved = true;
    if (!this._canvasDrag.moved) return;
    const raw = this._insertionIndexFor(e.clientY);
    if (raw !== this.dropIndex) { this.dropIndex = raw; this._render(); }
  }

  _onCanvasMouseUp(e) {
    if (!this._canvasDrag) return;
    const ds = this._canvasDrag;
    this._canvasDrag = null;
    this.dropIndex   = -1;
    if (!ds.moved) { this._select(ds.id); return; }

    const fromIdx  = ds.fromIdx;
    const insertAt = this._insertionIndexFor(e.clientY);
    const clamped  = Math.max(PipelineCanvas.SAMPLER_INDEX + 1, insertAt);
    const newIdx   = clamped > fromIdx ? clamped - 1 : clamped;
    if (newIdx !== fromIdx) {
      const [mod] = this.modules.splice(fromIdx, 1);
      this.modules.splice(newIdx, 0, mod);
      this.selectedId = null;
      document.dispatchEvent(
        new CustomEvent("pipeline:moduleSelected", { detail: null })
      );
    }
    this._render();
  }

  // ── Sidebar HTML drag & drop ──────────────────────────────────────

  _toSvgY(clientY) {
    const rect  = this.svg.getBoundingClientRect();
    const scale = this.svg.viewBox.baseVal.height > 0
      ? this.svg.viewBox.baseVal.height / rect.height : 1;
    return (clientY - rect.top) * scale;
  }

  _insertionIndexFor(clientY) {
    const svgY = this._toSvgY(clientY);
    const { MH } = PipelineCanvas;
    for (let i = 0; i < this.modules.length; i++)
      if (svgY < this._modY(i) + MH / 2)
        return Math.max(PipelineCanvas.SAMPLER_INDEX + 1, i);
    return this.modules.length;
  }

  _onDragOver(e) {
    if (this._canvasDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const idx = this._insertionIndexFor(e.clientY);
    if (idx !== this.dropIndex) { this.dropIndex = idx; this._render(); }
  }

  _onDragLeave(e) {
    if (!e.relatedTarget || !this.container.contains(e.relatedTarget)) {
      this.dropIndex = -1;
      this._render();
    }
  }

  _onDrop(e) {
    e.preventDefault();
    this.dropIndex = -1;
    const raw = e.dataTransfer.getData("application/json");
    if (!raw) { this._render(); return; }
    try {
      const data = JSON.parse(raw);
      const idx  = this._insertionIndexFor(e.clientY);
      this.modules.splice(idx, 0, {
        ...data,
        instanceId:  `${data.id}_${Date.now()}`,
        paramValues: {},
      });
      if (this.selectedId !== null) {
        this.selectedId = null;
        document.dispatchEvent(
          new CustomEvent("pipeline:moduleSelected", { detail: null })
        );
      }
    } catch (err) { console.error("Pipeline drop error:", err); }
    this._render();
  }

  // ── Initialisation ────────────────────────────────────────────────

  _initSVG() {
    this.svg = this._el("svg");
    this.svg.setAttribute("class", "pipeline-svg");
    this.container.appendChild(this.svg);

    const defs = this._el("defs");
    defs.innerHTML = `
      <marker id="arr-grey" markerWidth="8" markerHeight="6"
              refX="7" refY="3" orient="auto">
        <polygon points="0 0,8 3,0 6" fill="#94a3b8"/>
      </marker>
      <marker id="arr-blue" markerWidth="8" markerHeight="6"
              refX="7" refY="3" orient="auto">
        <polygon points="0 0,8 3,0 6" fill="#3b82f6"/>
      </marker>`;
    this.svg.appendChild(defs);

    this.svg.addEventListener("click", e => {
      if (e.target === this.svg || e.target.classList.contains("pipeline-bg"))
        this._select(null);
    });
    this.svg.addEventListener("dragover",  e => this._onDragOver(e));
    this.svg.addEventListener("dragleave", e => this._onDragLeave(e));
    this.svg.addEventListener("drop",      e => this._onDrop(e));
    document.addEventListener("mousemove", e => this._onCanvasMouseMove(e));
    document.addEventListener("mouseup",   e => this._onCanvasMouseUp(e));
  }
}
