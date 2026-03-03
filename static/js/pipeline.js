/**
 * pipeline.js — SVG-based pipeline canvas
 *
 * Renders a vertical linear sequence of module boxes (pipeline flows top→down).
 * When a module is clicked its input ports (green) appear to its left and its
 * output ports (amber) appear to its right.  Bezier arcs curve to the left
 * from any earlier module that produces a matching output to the corresponding
 * input port of the selected module.
 *
 * Modules can be dragged from the left sidebar and dropped onto the canvas;
 * a blue dashed indicator line shows the insertion position.
 */
class PipelineCanvas {
  // ── layout constants ──────────────────────────────────────────
  static SAMPLER_INDEX = 0; // The sampler is always at index 0 and cannot be removed.
  static MW  = 145;  // module width
  static MH  = 58;   // module height
  static MS  = 90;   // vertical spacing between modules
  static PAD = 60;   // top/bottom/side padding

  static PW  = 115;  // port box width
  static PH  = 22;   // port box height
  static PG  = 4;    // vertical gap between port boxes
  static PO  = 20;   // horizontal gap between port box and module edge

  constructor(containerId) {
    this.container  = document.getElementById(containerId);
    this.modules    = [];   // pipeline module objects
    this.selectedId = null; // instanceId of the selected module
    this.dropIndex  = -1;   // drop-indicator insertion index (-1 = hidden)

    this._initSVG();
  }

  // ── public API ────────────────────────────────────────────────

  /** Replace the full pipeline (called on initial load / server push). */
  setModules(modules) {

    this.modules = modules.map((m, i) => ({
      ...m,
      instanceId: m.instanceId || `${m.id}_${i}`,
    }));
    this._render();
  }

  /** Deselect any currently-selected module. */
  deselect() {
    this._select(null);
  }

  // ── private – initialisation ──────────────────────────────────

  _initSVG() {
    this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svg.setAttribute("class", "pipeline-svg");
    this.container.appendChild(this.svg);

    // Arrow marker defs
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
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

    // Click on background deselects
    this.svg.addEventListener("click", (e) => {
      if (e.target === this.svg || e.target.classList.contains("pipeline-bg")) {
        this._select(null);
      }
    });

    // Drag-and-drop from sidebar
    this.svg.addEventListener("dragover",  (e) => this._onDragOver(e));
    this.svg.addEventListener("dragleave", (e) => this._onDragLeave(e));
    this.svg.addEventListener("drop",      (e) => this._onDrop(e));
  }

  // ── private – coordinate helpers ─────────────────────────────

  /** Fixed X position for the left edge of every module box. */
  _modX() {
    return PipelineCanvas.PAD + PipelineCanvas.PW + PipelineCanvas.PO;
  }

  /** Y position for the top edge of module at pipeline index i. */
  _modY(i) {
    return PipelineCanvas.PAD + i * (PipelineCanvas.MH + PipelineCanvas.MS);
  }

  _svgWidth() {
    const { PAD, PW, PO, MW } = PipelineCanvas;
    const natural = PAD + PW + PO + MW + PO + PW + PAD;
    return Math.max(natural, this.container.clientWidth || 600);
  }

  _svgHeight() {
    const { PAD, MH, MS } = PipelineCanvas;
    const n = this.modules.length || 1;
    const natural = PAD * 2 + n * MH + (n - 1) * MS;
    return Math.max(natural, this.container.clientHeight || 400);
  }

  // ── private – full render ────────────────────────────────────

  _render() {
    // Remove everything after defs (children[0])
    while (this.svg.childNodes.length > 1) {
      this.svg.removeChild(this.svg.lastChild);
    }

    const w = this._svgWidth();
    const h = this._svgHeight();
    this.svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.svg.setAttribute("width",  w);
    this.svg.setAttribute("height", h);

    // Background
    this._appendBg(w, h);

    // Layers rendered in z-order (back → front):
    //  1. Port edges (arcs below everything)
    //  2. Pipeline arrows
    //  3. Module boxes
    //  4. Port boxes + connectors
    //  5. Drop indicator

    let selIdx = -1;
    if (this.selectedId) {
      selIdx = this.modules.findIndex((m) => m.instanceId === this.selectedId);
    }

    if (selIdx >= 0) this._appendPortEdges(selIdx);
    this._appendConnections();
    this.modules.forEach((m, i) => this._appendModule(m, i));
    if (selIdx >= 0) this._appendPorts(this.modules[selIdx], selIdx);
    if (this.dropIndex >= 0) this._appendDropIndicator(this.dropIndex);
  }

  // ── private – SVG element builders ───────────────────────────

  _appendBg(w, h) {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("width",  w);
    r.setAttribute("height", h);
    r.setAttribute("fill",   "#f1f5f9");
    r.setAttribute("class",  "pipeline-bg");
    this.svg.appendChild(r);
  }

  /** Vertical arrows between consecutive modules. */
  _appendConnections() {
    const { MW, MH } = PipelineCanvas;
    const cx = this._modX() + MW / 2;
    for (let i = 0; i < this.modules.length - 1; i++) {
      const y1 = this._modY(i) + MH;
      const y2 = this._modY(i + 1) - 6;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
      el.setAttribute("x1", cx);
      el.setAttribute("y1", y1);
      el.setAttribute("x2", cx);
      el.setAttribute("y2", y2);
      el.setAttribute("stroke",       "#94a3b8");
      el.setAttribute("stroke-width", "2");
      el.setAttribute("marker-end",   "url(#arr-grey)");
      this.svg.appendChild(el);
    }
  }

  /** A single module box with label (and optional remove button). */
  _appendModule(module, index) {
    const x   = this._modX();
    const y   = this._modY(index);
    const id  = module.instanceId;
    const sel = id === this.selectedId;
    const perm = !!module.permanent;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("class", "module-group");
    g.setAttribute("data-id", id);

    // Box
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x",      x);
    rect.setAttribute("y",      y);
    rect.setAttribute("width",  PipelineCanvas.MW);
    rect.setAttribute("height", PipelineCanvas.MH);
    rect.setAttribute("rx",     "8");
    let cls = "module-rect";
    if (perm) cls += " permanent";
    if (sel)  cls += " selected";
    rect.setAttribute("class", cls);
    g.appendChild(rect);

    // Label
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x",                x + PipelineCanvas.MW / 2);
    text.setAttribute("y",                y + PipelineCanvas.MH / 2);
    text.setAttribute("text-anchor",      "middle");
    text.setAttribute("dominant-baseline","middle");
    text.setAttribute("class",            "module-text");
    text.textContent = module.name;
    g.appendChild(text);

    // Remove button (non-permanent only)
    if (!perm) {
      const rm = document.createElementNS("http://www.w3.org/2000/svg", "text");
      rm.setAttribute("x",           x + PipelineCanvas.MW - 9);
      rm.setAttribute("y",           y + 16);
      rm.setAttribute("text-anchor", "middle");
      rm.setAttribute("class",       "module-remove");
      rm.textContent = "×";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        this._removeModule(id);
      });
      g.appendChild(rm);
    }

    g.addEventListener("click", (e) => {
      e.stopPropagation();
      this._select(id);
    });

    this.svg.appendChild(g);
  }

  /** Input/output port boxes for the selected module. */
  _appendPorts(module, index) {
    const mx = this._modX();
    const my = this._modY(index);
    const { MW, MH, PW, PH, PG, PO } = PipelineCanvas;

    const inputs  = module.inputs  || [];
    const outputs = module.outputs || [];

    // ── input ports (left of module) ──
    if (inputs.length > 0) {
      const totalH = inputs.length * (PH + PG) - PG;
      const startY = my + (MH - totalH) / 2;
      const portX  = mx - PO - PW;

      inputs.forEach((port, i) => {
        const portY = startY + i * (PH + PG);
        const cy    = portY + PH / 2;

        // bezier connector: port right edge → module left edge (arcs left)
        const path = this._makeBezierConnector(portX + PW, cy, mx, cy, "left");
        this.svg.appendChild(path);

        const rect = this._makePortRect(portX, portY, "input-port");
        this.svg.appendChild(rect);

        const lbl = this._makePortLabel(portX, portY, PW, PH, port.name);
        this.svg.appendChild(lbl);
      });
    }

    // ── output ports (right of module) ──
    if (outputs.length > 0) {
      const totalH = outputs.length * (PH + PG) - PG;
      const startY = my + (MH - totalH) / 2;
      const portX  = mx + MW + PO;

      outputs.forEach((port, i) => {
        const portY = startY + i * (PH + PG);
        const cy    = portY + PH / 2;

        // bezier connector: module right edge → port left edge (arcs right)
        const path = this._makeBezierConnector(mx + MW, cy, portX, cy, "right");
        this.svg.appendChild(path);

        const rect = this._makePortRect(portX, portY, "output-port");
        this.svg.appendChild(rect);

        const lbl = this._makePortLabel(portX, portY, PW, PH, port.name);
        this.svg.appendChild(lbl);
      });
    }
  }

  /**
   * Blue bezier arcs from source modules → input ports of the selected module.
   * Each arc curves to the LEFT of the pipeline column.
   */
  _appendPortEdges(selIdx) {
    const module  = this.modules[selIdx];
    const inputs  = module.inputs || [];
    if (inputs.length === 0) return;

    const { MW, MH, PW, PH, PG, PO } = PipelineCanvas;
    const mx = this._modX();
    const my = this._modY(selIdx);

    const totalH = inputs.length * (PH + PG) - PG;
    const startY = my + (MH - totalH) / 2;
    const portX  = mx - PO - PW; // left edge of input port boxes

    inputs.forEach((input, i) => {
      const portCY = startY + i * (PH + PG) + PH / 2;

      // Find the nearest earlier module that produces this output
      for (let j = selIdx - 1; j >= 0; j--) {
        const src = this.modules[j];
        const has = (src.outputs || []).some((o) => o.name === input.name);
        if (!has) continue;

        const srcX = mx + MW / 2;              // horizontal center of source module
        const srcY = this._modY(j) + MH;       // bottom edge of source module
        const tgtX = portX + PW;               // right edge of left-side input port box
        const tgtY = portCY;

        // Arc bulges to the LEFT of the port column
        const arcX  = portX - 50;
        const d = [
          `M ${srcX} ${srcY}`,
          `C ${arcX} ${srcY},`,
          `  ${arcX} ${tgtY},`,
          `  ${tgtX} ${tgtY}`,
        ].join(" ");

        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
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

  /** Blue dashed horizontal line showing the drop-insertion point. */
  _appendDropIndicator(index) {
    // Clamp: never before sampler
    const clamped = Math.max(PipelineCanvas.SAMPLER_INDEX + 1, Math.min(index, this.modules.length));
    let y;
    if (clamped < this.modules.length) {
      y = this._modY(clamped) - PipelineCanvas.MS / 2;
    } else {
      y = this._modY(this.modules.length - 1) + PipelineCanvas.MH + PipelineCanvas.MS / 2;
    }

    const mx = this._modX();
    const x1 = mx - 22;
    const x2 = mx + PipelineCanvas.MW + 22;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1",              x1);
    line.setAttribute("y1",              y);
    line.setAttribute("x2",              x2);
    line.setAttribute("y2",              y);
    line.setAttribute("class",           "insertion-indicator");
    line.setAttribute("stroke",          "#3b82f6");
    line.setAttribute("stroke-width",    "2.5");
    line.setAttribute("stroke-dasharray","6 3");
    this.svg.appendChild(line);
  }

  // ── private – SVG element factories ──────────────────────────

  /**
   * Bezier connector between a port box edge and the module edge.
   * side = "left"  → arc bulges left  (input ports)
   * side = "right" → arc bulges right (output ports)
   */
  _makeBezierConnector(x1, y1, x2, y2, side) {
    const span  = Math.abs(x2 - x1);
    const bulge = span * 0.5;
    const sign  = side === "right" ? 1 : -1;
    const cp1x  = x1 + sign * bulge;
    const cp2x  = x2 + sign * bulge;
    const d = `M ${x1} ${y1} C ${cp1x} ${y1}, ${cp2x} ${y2}, ${x2} ${y2}`;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("d",     d);
    el.setAttribute("fill",  "none");
    el.setAttribute("class", "port-connector");
    return el;
  }

  _makePortRect(x, y, cls) {
    const { PW, PH } = PipelineCanvas;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    el.setAttribute("x",      x);
    el.setAttribute("y",      y);
    el.setAttribute("width",  PW);
    el.setAttribute("height", PH);
    el.setAttribute("rx",     "4");
    el.setAttribute("class",  `port-rect ${cls}`);
    return el;
  }

  _makePortLabel(portX, portY, portW, portH, name) {
    const label = name.split("/").pop(); // strip section prefix
    const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
    el.setAttribute("x",                portX + portW / 2);
    el.setAttribute("y",                portY + portH / 2);
    el.setAttribute("text-anchor",      "middle");
    el.setAttribute("dominant-baseline","middle");
    el.setAttribute("class",            "port-label");
    el.textContent = label;
    return el;
  }

  // ── private – selection & mutation ───────────────────────────

  _select(id) {
    this.selectedId = id;
    this._render();

    const module = id
      ? this.modules.find((m) => m.instanceId === id) || null
      : null;
    document.dispatchEvent(
      new CustomEvent("pipeline:moduleSelected", { detail: module })
    );
  }

  _removeModule(id) {
    const idx = this.modules.findIndex((m) => m.instanceId === id);
    if (idx <= PipelineCanvas.SAMPLER_INDEX) return; // never remove sampler
    this.modules.splice(idx, 1);
    if (this.selectedId === id) {
      this.selectedId = null;
      document.dispatchEvent(
        new CustomEvent("pipeline:moduleSelected", { detail: null })
      );
    }
    this._render();
  }

  // ── private – drag & drop ────────────────────────────────────

  /** Convert a screen clientY to an SVG y coordinate. */
  _toSvgY(clientY) {
    const rect  = this.svg.getBoundingClientRect();
    const scale = this.svg.viewBox.baseVal.height > 0
      ? this.svg.viewBox.baseVal.height / rect.height
      : 1;
    return (clientY - rect.top) * scale;
  }

  /**
   * Return the insertion index based on mouse y.
   * Result is clamped to [1, modules.length] (never before sampler).
   */
  _insertionIndexFor(clientY) {
    const svgY = this._toSvgY(clientY);
    const { MH } = PipelineCanvas;
    for (let i = 0; i < this.modules.length; i++) {
      if (svgY < this._modY(i) + MH / 2) {
        return Math.max(PipelineCanvas.SAMPLER_INDEX + 1, i);
      }
    }
    return this.modules.length;
  }

  _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const idx = this._insertionIndexFor(e.clientY);
    if (idx !== this.dropIndex) {
      this.dropIndex = idx;
      this._render();
    }
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
        instanceId: `${data.id}_${Date.now()}`,
      });
      // Deselect when a new module is added so stale port boxes disappear
      if (this.selectedId !== null) {
        this.selectedId = null;
        document.dispatchEvent(
          new CustomEvent("pipeline:moduleSelected", { detail: null })
        );
      }
    } catch (err) {
      console.error("Pipeline drop error:", err);
    }

    this._render();
  }
}
