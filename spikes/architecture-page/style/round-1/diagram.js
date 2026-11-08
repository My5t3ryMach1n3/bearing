/* global window, document */
// A small SVG renderer for the style round's mock-ups: draws one level of window.PAGE from its ELK layout, with hooks
// for each mock-up to style it. Not the page's real renderer.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs = {}, parent) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) if (value !== undefined) node.setAttribute(key, value);
    if (parent) parent.appendChild(node);
    return node;
  };
  const text = (parent, value, attrs) => {
    const node = el("text", attrs, parent);
    node.textContent = value;
    return node;
  };

  function pathData(points, curve) {
    let d = `M${points[0][0]},${points[0][1]}`;
    if (!curve) {
      for (const [x, y] of points.slice(1)) d += ` L${x},${y}`;
      return d;
    }
    let i = 1;
    for (; i + 2 < points.length; i += 3) {
      d += ` C${points[i][0]},${points[i][1]} ${points[i + 1][0]},${points[i + 1][1]} ${points[i + 2][0]},${points[i + 2][1]}`;
    }
    const rest = points.slice(i);
    if (rest.length === 2) d += ` Q${rest[0][0]},${rest[0][1]} ${rest[1][0]},${rest[1][1]}`;
    if (rest.length === 1) d += ` L${rest[0][0]},${rest[0][1]}`;
    return d;
  }

  function midpoint(points) {
    let total = 0;
    const lengths = points.slice(1).map((p, i) => {
      const l = Math.hypot(p[0] - points[i][0], p[1] - points[i][1]);
      total += l;
      return l;
    });
    let walk = total / 2;
    for (let i = 0; i < lengths.length; i++) {
      if (walk <= lengths[i]) {
        const t = lengths[i] === 0 ? 0 : walk / lengths[i];
        return [
          points[i][0] + t * (points[i + 1][0] - points[i][0]),
          points[i][1] + t * (points[i + 1][1] - points[i][1]),
        ];
      }
      walk -= lengths[i];
    }
    return points[points.length - 1];
  }

  function shapeFor(group, element, box, radius) {
    const { x, y, width: w, height: h } = box;
    if (element.type === "person") {
      el("circle", { cx: x + w / 2, cy: y + 13, r: 12, class: "shape" }, group);
      el("rect", { x, y: y + 22, width: w, height: h - 22, rx: 18, class: "shape" }, group);
      return { top: y + 22 };
    }
    if (element.shape === "Cylinder") {
      const ry = 7;
      el(
        "path",
        {
          d: `M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z`,
          class: "shape",
        },
        group,
      );
      el("path", { d: `M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}`, class: "shape-line" }, group);
      return { top: y + ry * 2 };
    }
    if (element.shape === "WebBrowser") {
      el("rect", { x, y, width: w, height: h, rx: radius, class: "shape" }, group);
      el("line", { x1: x, y1: y + 12, x2: x + w, y2: y + 12, class: "shape-line" }, group);
      for (const i of [0, 1, 2]) el("circle", { cx: x + 9 + i * 7, cy: y + 6, r: 2, class: "shape-dot" }, group);
      return { top: y + 12 };
    }
    el("rect", { x, y, width: w, height: h, rx: radius, class: "shape" }, group);
    return { top: y };
  }

  const kindOf = (element) =>
    element.kind ??
    { person: "Person", softwareSystem: "Software system", container: "Container", component: "Component" }[
      element.type
    ];

  // options:
  //   include: ids of the elements to draw (default: all of the level's); edges between them only
  //   drift: draw the level's drifted relationships too
  //   nodeClass(id), edgeClass(edge): extra classes
  //   label(edge): the edge's label, or null for none (default: its own)
  //   kind: show the kind line (default true); technology: show it (default true)
  //   decorate(id, group, box): add to a box; decorateEdge(edge, group, points)
  //   pad: space around what's drawn; radius: box corner radius; boundary: draw the scope (default true)
  function render(levelId, options = {}) {
    const page = window.PAGE;
    const level = page.levels.find((each) => each.id === levelId);
    const { shapes, routes } = level.layout;
    const include = new Set(options.include ?? level.nodes);
    const radius = options.radius ?? 6;
    const svg = el("svg", { class: "diagram", role: "img" });
    const edgesLayer = el("g", { class: "edges" });
    const nodesLayer = el("g", { class: "nodes" });
    const labelsLayer = el("g", { class: "labels" });

    const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    const grow = (x, y, w = 0, h = 0) => {
      bounds.x0 = Math.min(bounds.x0, x);
      bounds.y0 = Math.min(bounds.y0, y);
      bounds.x1 = Math.max(bounds.x1, x + w);
      bounds.y1 = Math.max(bounds.y1, y + h);
    };

    const scope = level.scope;
    const insideIds = level.nodes.filter((id) => page.elements[id]?.parent === scope && scope !== undefined);
    if (scope !== undefined && options.boundary !== false && insideIds.some((id) => include.has(id))) {
      const drawn = insideIds.filter((id) => include.has(id)).map((id) => shapes[id]);
      const full = shapes[`boundary:${scope}`];
      // A cropped diagram draws only as much of the boundary as holds what it shows.
      const box =
        options.include === undefined
          ? full
          : (() => {
              const x0 = Math.min(...drawn.map((b) => b.x)) - 20,
                y0 = Math.min(...drawn.map((b) => b.y)) - 34;
              const x1 = Math.max(...drawn.map((b) => b.x + b.width)) + 20,
                y1 = Math.max(...drawn.map((b) => b.y + b.height)) + 20;
              return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
            })();
      const g = el("g", { class: "boundary" }, svg);
      el(
        "rect",
        { x: box.x, y: box.y, width: box.width, height: box.height, rx: radius + 4, class: "boundary-box" },
        g,
      );
      text(g, page.elements[scope].name, { x: box.x + 14, y: box.y + 21, class: "boundary-name" });
      grow(box.x, box.y, box.width, box.height);
    }
    svg.appendChild(edgesLayer);
    svg.appendChild(nodesLayer);
    svg.appendChild(labelsLayer);

    const all = [
      ...level.edges.map((edge) => ({ ...edge, drift: false })),
      ...(options.drift ? level.drift.map((edge) => ({ ...edge, drift: true })) : []),
    ];
    const drawnEdges = {};
    for (const edge of all) {
      if (!include.has(edge.source) || !include.has(edge.destination)) continue;
      if (options.edgeFilter && !options.edgeFilter(edge)) continue;
      const route = routes[edge.id];
      if (route === undefined) continue;
      const g = el(
        "g",
        { class: `edge ${edge.drift ? "drift" : ""} ${options.edgeClass?.(edge) ?? ""}`, "data-id": edge.id },
        edgesLayer,
      );
      el("path", { d: pathData(route.points, route.curve), class: "edge-line" }, g);
      // Arrowhead along the last run.
      const n = route.points.length;
      const [ex, ey] = route.points[n - 1];
      const [px, py] = route.points[n - 2];
      const angle = Math.atan2(ey - py, ex - px);
      const a = 7,
        s = 4;
      const p1 = [ex - a * Math.cos(angle) + s * Math.sin(angle), ey - a * Math.sin(angle) - s * Math.cos(angle)];
      const p2 = [ex - a * Math.cos(angle) - s * Math.sin(angle), ey - a * Math.sin(angle) + s * Math.cos(angle)];
      el("path", { d: `M${ex},${ey} L${p1[0]},${p1[1]} L${p2[0]},${p2[1]} Z`, class: "edge-head" }, g);
      for (const [x, y] of route.points) grow(x, y);
      const label = options.label ? options.label(edge) : edge.label;
      if (label && route.label) {
        const lg = el(
          "g",
          { class: `edge-label ${edge.drift ? "drift" : ""} ${options.edgeClass?.(edge) ?? ""}`, "data-id": edge.id },
          labelsLayer,
        );
        text(lg, label, { x: route.label.x, y: route.label.y + 11 });
        grow(route.label.x, route.label.y, route.label.width, 14);
      }
      drawnEdges[edge.id] = { edge, group: g, points: route.points, mid: midpoint(route.points) };
      options.decorateEdge?.(edge, g, route.points, labelsLayer);
    }

    for (const id of level.nodes) {
      if (!include.has(id)) continue;
      const element = page.elements[id];
      const box = shapes[id];
      const classes = ["node", element.type, element.external ? "external" : "", options.nodeClass?.(id) ?? ""];
      const g = el(
        "g",
        { class: classes.join(" "), "data-id": id, tabindex: options.focusable ? 0 : undefined },
        nodesLayer,
      );
      const { top } = shapeFor(g, element, box, radius);
      const cx = box.x + box.width / 2;
      const body = top + (box.y + box.height - top) / 2;
      const showKind = options.kind !== false;
      const tech = options.technology !== false ? element.technology : "";
      const lines = [
        showKind ? ["kind", kindOf(element) + (element.external ? ", external" : "")] : null,
        ["name", element.name],
        tech ? ["tech", tech] : null,
      ].filter(Boolean);
      const heights = { kind: 14, name: 17, tech: 14 };
      const total = lines.reduce((sum, [k]) => sum + heights[k], 0);
      let y = body - total / 2;
      for (const [k, value] of lines) {
        y += heights[k];
        text(g, value, { x: cx, y: y - 4, class: `node-${k}`, "text-anchor": "middle" });
      }
      grow(box.x, box.y, box.width, box.height);
      options.decorate?.(id, g, box);
    }

    const pad = options.pad ?? 16;
    const vb = [bounds.x0 - pad, bounds.y0 - pad, bounds.x1 - bounds.x0 + 2 * pad, bounds.y1 - bounds.y0 + 2 * pad];
    svg.setAttribute("viewBox", vb.join(" "));
    svg.dataset.width = vb[2];
    svg.style.setProperty("--natural-width", `${vb[2]}px`);
    svg.edges = drawnEdges;
    return svg;
  }

  // The level edge a dynamic view's step runs along.
  function stepEdge(levelId, step) {
    const level = window.PAGE.levels.find((each) => each.id === levelId);
    return level.edges.find((edge) => edge.source === step.source && edge.destination === step.destination);
  }

  window.Diagram = { render, stepEdge, el, text, midpoint };
})();
