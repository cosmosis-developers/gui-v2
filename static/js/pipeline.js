/**
 * pipeline.js — SVG-based pipeline canvas
 *
 * Renders a horizontal linear sequence of module boxes.  When a module is
 * clicked its input ports (green) appear to its left and its output ports
 * (amber) appear to its right, connected by dashed lines.  Bezier arcs are
 * drawn from any earlier module that produces a matching output to the
 * corresponding input port of the selected module.
 *
 * Modules can be dragged from the left sidebar and dropped onto the canvas;
 * a blue dashed indicator line shows the insertion position.
 */
class PipelineCanvas {
  // ── layout constants ──────────────────────────────────────────
  static SAMPLER_INDEX = 0; // The sampler is always at index 0 and cannot be removed.
  static MW  = 145;  // module width
  static MH  = 58;   // module height
  static MS  = 230;  // horizontal spacing between modules (gap)
  static CH  = 340;  // canvas height
  static PAD = 60;   // left/right padding

  static PW  = 115;  // port box width
  static PH  = 22;   // port box height
  static PG  = 4;    // vertical gap between port boxes
  static PO  = 14;   // horizontal gap between port box and module edge

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

  _modX(i) {
    return PipelineCanvas.PAD + i * (PipelineCanvas.MW + PipelineCanvas.MS);
  }

  _modY() {
    return (PipelineCanvas.CH - PipelineCanvas.MH) / 2;
  }

  _svgWidth() {
    const n = this.modules.length || 1;
    const natural = PipelineCanvas.PAD * 2
                  + n * PipelineCanvas.MW
                  + (n - 1) * PipelineCanvas.MS;
    return Math.max(natural, this.container.clientWidth || 800);
  }

  // ── private – full render ────────────────────────────────────

  _render() {
    // Remove everything after defs (children[0])
    while (this.svg.childNodes.length > 1) {
      this.svg.removeChild(this.svg.lastChild);
    }

    const w = this._svgWidth();
    const h = PipelineCanvas.CH;
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

  /** Horizontal arrows between consecutive modules. */
  _appendConnections() {
    const cy = this._modY() + PipelineCanvas.MH / 2;
    for (let i = 0; i < this.modules.length - 1; i++) {
      const x1 = this._modX(i) + PipelineCanvas.MW;
      const x2 = this._modX(i + 1) - 6;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
      el.setAttribute("x1", x1);
      el.setAttribute("y1", cy);
      el.setAttribute("x2", x2);
      el.setAttribute("y2", cy);
      el.setAttribute("stroke",       "#94a3b8");
      el.setAttribute("stroke-width", "2");
      el.setAttribute("marker-end",   "url(#arr-grey)");
      this.svg.appendChild(el);
    }
  }

  /** A single module box with label (and optional remove button). */
  _appendModule(module, index) {
    const x   = this._modX(index);
    const y   = this._modY();
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
    const mx = this._modX(index);
    const my = this._modY();
    const { PW, PH, PG, PO } = PipelineCanvas;

    const inputs  = module.inputs  || [];
    const outputs = module.outputs || [];

    // ── input ports (left of module) ──
    if (inputs.length > 0) {
      const totalH = inputs.length * (PH + PG) - PG;
      const startY = my + (PipelineCanvas.MH - totalH) / 2;
      const portX  = mx - PO - PW;

      inputs.forEach((port, i) => {
        const portY = startY + i * (PH + PG);
        const cy    = portY + PH / 2;

        // dashed connector: port right edge → module left edge
        const line = this._makeLine(portX + PW, cy, mx, cy, "port-connector");
        this.svg.appendChild(line);

        const rect = this._makePortRect(portX, portY, "input-port");
        this.svg.appendChild(rect);

        const lbl = this._makePortLabel(portX, portY, PW, PH, port.name);
        this.svg.appendChild(lbl);
      });
    }

    // ── output ports (right of module) ──
    if (outputs.length > 0) {
      const totalH = outputs.length * (PH + PG) - PG;
      const startY = my + (PipelineCanvas.MH - totalH) / 2;
      const portX  = mx + PipelineCanvas.MW + PO;

      outputs.forEach((port, i) => {
        const portY = startY + i * (PH + PG);
        const cy    = portY + PH / 2;

        // dashed connector: module right edge → port left edge
        const line = this._makeLine(mx + PipelineCanvas.MW, cy, portX, cy, "port-connector");
        this.svg.appendChild(line);

        const rect = this._makePortRect(portX, portY, "output-port");
        this.svg.appendChild(rect);

        const lbl = this._makePortLabel(portX, portY, PW, PH, port.name);
        this.svg.appendChild(lbl);
      });
    }
  }

  /**
   * Blue bezier arcs from source modules → input ports of the selected module.
   * Each arc curves above the pipeline baseline.
   */
  _appendPortEdges(selIdx) {
    const module  = this.modules[selIdx];
    const inputs  = module.inputs || [];
    if (inputs.length === 0) return;

    const mx = this._modX(selIdx);
    const my = this._modY();
    const { PW, PH, PG, PO } = PipelineCanvas;

    const totalH = inputs.length * (PH + PG) - PG;
    const startY = my + (PipelineCanvas.MH - totalH) / 2;
    const portX  = mx - PO - PW; // left edge of input port boxes

    inputs.forEach((input, i) => {
      const portCY = startY + i * (PH + PG) + PH / 2;

      // Find the nearest earlier module that produces this output
      for (let j = selIdx - 1; j >= 0; j--) {
        const src = this.modules[j];
        const has = (src.outputs || []).some((o) => o.name === input.name);
        if (!has) continue;

        const srcX  = this._modX(j) + PipelineCanvas.MW; // right edge of source
        const srcY  = this._modY() + PipelineCanvas.MH / 2;
        const tgtX  = portX;
        const tgtY  = portCY;
        const arcY  = my - 50; // arc apex above pipeline
        const cpOff = Math.abs(tgtX - srcX) * 0.35;

        const d = [
          `M ${srcX} ${srcY}`,
          `C ${srcX + cpOff} ${arcY},`,
          `  ${tgtX - cpOff} ${arcY},`,
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

  /** Blue dashed vertical line showing the drop-insertion point. */
  _appendDropIndicator(index) {
    // Clamp: never before sampler
    const clamped = Math.max(PipelineCanvas.SAMPLER_INDEX + 1, Math.min(index, this.modules.length));
    let x;
    if (clamped < this.modules.length) {
      x = this._modX(clamped) - PipelineCanvas.MS / 2;
    } else {
      x = this._modX(this.modules.length - 1) + PipelineCanvas.MW + PipelineCanvas.MS / 2;
    }

    const y1 = this._modY() - 22;
    const y2 = this._modY() + PipelineCanvas.MH + 22;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1",             x);
    line.setAttribute("y1",             y1);
    line.setAttribute("x2",             x);
    line.setAttribute("y2",             y2);
    line.setAttribute("class",          "insertion-indicator");
    line.setAttribute("stroke",         "#3b82f6");
    line.setAttribute("stroke-width",   "2.5");
    line.setAttribute("stroke-dasharray","6 3");
    this.svg.appendChild(line);
  }

  // ── private – SVG element factories ──────────────────────────

  _makeLine(x1, y1, x2, y2, cls) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "line");
    el.setAttribute("x1", x1); el.setAttribute("y1", y1);
    el.setAttribute("x2", x2); el.setAttribute("y2", y2);
    el.setAttribute("class", cls);
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

  /** Convert a screen clientX to an SVG x coordinate. */
  _toSvgX(clientX) {
    const rect  = this.svg.getBoundingClientRect();
    const scale = this.svg.viewBox.baseVal.width > 0
      ? this.svg.viewBox.baseVal.width / rect.width
      : 1;
    return (clientX - rect.left) * scale;
  }

  /**
   * Return the insertion index based on mouse x.
   * Result is clamped to [1, modules.length] (never before sampler).
   */
  _insertionIndexFor(clientX) {
    const svgX = this._toSvgX(clientX);
    for (let i = 0; i < this.modules.length; i++) {
      if (svgX < this._modX(i) + PipelineCanvas.MW / 2) {
        return Math.max(PipelineCanvas.SAMPLER_INDEX + 1, i);
      }
    }
    return this.modules.length;
  }

  _onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const idx = this._insertionIndexFor(e.clientX);
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
      const idx  = this._insertionIndexFor(e.clientX);
      this.modules.splice(idx, 0, {
        ...data,
        instanceId: `${data.id}_${Date.now()}`,
      });
    } catch (err) {
      console.error("Pipeline drop error:", err);
    }

    this._render();
  }
}
