// Asterism webview. Receives GraphData from the extension and draws it.
(function () {
  'use strict';

  const vscode =
    typeof acquireVsCodeApi === 'function'
      ? acquireVsCodeApi()
      : { postMessage: (m) => window.__posted && window.__posted.push(m), getState: () => undefined, setState: () => {} };
  const $ = (id) => document.getElementById(id);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const hasFcose = typeof window.cytoscapeFcose === 'function';
  if (hasFcose) cytoscape.use(window.cytoscapeFcose);

  // ---------------------------------------------------------------------------
  // State

  const saved = vscode.getState() || {};
  const state = {
    grouping: saved.grouping || 'file', // folder | file | none
    collapsed: new Set(), // container ids (folders, files, classes)
    hidden: new Set(), // symbol or container ids
    edges: { calls: true, inherit: true, references: true },
    outline: saved.outline !== false,
    selected: null,
    query: '',
  };

  let data = null; // GraphData from the extension
  let symbolsById = new Map();
  let groups = new Map(); // folder/file containers: id -> { id, label, kind }
  let children = new Map(); // parent id ('' for top level) -> child ids
  let parentOf = new Map(); // id -> parent id or null
  const positions = new Map(); // remembered node positions, kept across renders
  let colors; // read from the theme once the helpers below exist
  let cy;

  const persist = () => vscode.setState({ grouping: saved.grouping, outline: state.outline });

  // ---------------------------------------------------------------------------
  // Theme

  const probe = document.createElement('canvas').getContext('2d');

  /** Cytoscape does not understand #rrggbbaa, so normalise every colour to #rrggbb. */
  function solid(value, fallback) {
    probe.fillStyle = fallback;
    probe.fillStyle = (value || '').trim() || fallback;
    const c = probe.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
    const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('') : c;
  }

  /** Cytoscape only accepts double-quoted family names. */
  function fontList(value, fallback) {
    return ((value || '').trim() || fallback).replace(/'/g, '"');
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => solid(cs.getPropertyValue(name), fallback);
    return {
      bg: v('--vscode-editor-background', '#1e1e1e'),
      fg: v('--vscode-editor-foreground', '#d4d4d4'),
      muted: v('--vscode-descriptionForeground', '#9d9d9d'),
      line: v('--vscode-editorIndentGuide-background1', '#404040'),
      focus: v('--vscode-focusBorder', '#007fd4'),
      fn: v('--vscode-symbolIcon-functionForeground', '#b180d7'),
      cls: v('--vscode-symbolIcon-classForeground', '#ee9d28'),
      iface: v('--vscode-symbolIcon-interfaceForeground', '#75beff'),
      variable: v('--vscode-symbolIcon-variableForeground', '#75beff'),
      out: v('--vscode-charts-blue', '#3794ff'),
      in: v('--vscode-charts-green', '#89d185'),
      codeFont: fontList(cs.getPropertyValue('--vscode-editor-font-family'), 'Menlo, Consolas, monospace'),
      uiFont: fontList(cs.getPropertyValue('--vscode-font-family'), 'system-ui, sans-serif'),
    };
  }

  function stylesheet() {
    const c = colors;
    const kind = (k, color, extra) => ({
      selector: `node[kind="${k}"]`,
      style: Object.assign({ 'border-color': color, 'background-color': color }, extra || {}),
    });
    return [
      {
        selector: 'node',
        style: {
          shape: 'round-rectangle',
          height: 24,
          'background-color': c.fg,
          'background-opacity': 0.14,
          'border-width': 1.5,
          'border-color': c.muted,
          label: 'data(label)',
          color: c.fg,
          'font-family': c.codeFont,
          'font-size': 12,
          'text-valign': 'center',
          'text-halign': 'center',
          'overlay-opacity': 0,
          'transition-property': 'opacity',
          'transition-duration': reduceMotion ? 0 : 150,
        },
      },
      { selector: 'node:childless', style: { width: 'data(w)' } },
      kind('function', c.fn),
      kind('method', c.fn),
      kind('class', c.cls),
      kind('interface', c.iface, { 'border-style': 'dashed' }),
      kind('variable', c.variable, { 'border-style': 'dotted', shape: 'rectangle', height: 20, 'font-size': 11 }),
      { selector: 'node[?root]', style: { 'border-width': 3, 'font-weight': 'bold' } },

      // Groups (compound nodes)
      {
        selector: ':parent',
        style: {
          'background-color': c.fg,
          'background-opacity': 0.035,
          'border-width': 1,
          'border-color': c.line,
          padding: 14,
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -3,
          color: c.muted,
          'font-family': c.uiFont,
          'font-size': 11,
        },
      },
      { selector: 'node[kind="folder"]:parent', style: { 'border-style': 'dashed', 'background-opacity': 0 } },
      {
        selector: 'node[kind="class"]:parent, node[kind="interface"]:parent',
        style: { 'background-opacity': 0.06, 'border-width': 1.5, color: c.cls, 'font-family': c.codeFont, 'font-size': 12 },
      },
      { selector: 'node[kind="interface"]:parent', style: { color: c.iface } },

      // Collapsed groups shown as a single node
      {
        selector: 'node[?collapsed]',
        style: { 'border-style': 'double', 'border-width': 4, height: 30 },
      },
      {
        selector: 'node[kind="folder"][?collapsed], node[kind="file"][?collapsed]',
        style: { 'font-family': c.uiFont, 'background-color': c.fg, 'background-opacity': 0.07, 'border-color': c.muted },
      },

      // Edges
      {
        selector: 'edge',
        style: {
          width: 'data(width)',
          'curve-style': 'bezier',
          'line-color': c.muted,
          'target-arrow-color': c.muted,
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.8,
          opacity: 0.75,
          'overlay-opacity': 0,
        },
      },
      {
        selector: 'edge[kind="extends"], edge[kind="implements"]',
        style: { 'line-color': c.cls, 'target-arrow-color': c.cls, 'target-arrow-fill': 'hollow', 'arrow-scale': 1.2 },
      },
      { selector: 'edge[kind="implements"]', style: { 'line-style': 'dashed', 'line-color': c.iface, 'target-arrow-color': c.iface } },
      {
        selector: 'edge[kind="references"]',
        style: { 'line-style': 'dotted', 'line-color': c.variable, 'target-arrow-color': c.variable, 'target-arrow-shape': 'circle', 'arrow-scale': 0.6 },
      },
      {
        selector: 'edge[count > 1]',
        style: {
          label: 'data(count)',
          'font-size': 10,
          color: c.muted,
          'text-background-color': c.bg,
          'text-background-opacity': 1,
          'text-background-padding': 2,
          'font-family': c.uiFont,
        },
      },

      // Tracing: selected node, what it uses (out) and what uses it (in)
      { selector: '.faded', style: { opacity: 0.18 } },
      { selector: 'edge.faded', style: { opacity: 0.06 } },
      { selector: 'edge.out', style: { 'line-color': c.out, 'target-arrow-color': c.out, opacity: 1, 'z-index': 10 } },
      { selector: 'edge.in', style: { 'line-color': c.in, 'target-arrow-color': c.in, opacity: 1, 'z-index': 10 } },
      { selector: 'node.focus', style: { 'border-color': c.focus, 'border-width': 3 } },
      { selector: 'node.match', style: { 'underlay-color': c.focus, 'underlay-opacity': 0.4, 'underlay-padding': 5, 'underlay-shape': 'round-rectangle' } },
    ];
  }

  // ---------------------------------------------------------------------------
  // Structure: folders > files > classes > members, according to the grouping

  function buildStructure() {
    groups = new Map();
    children = new Map();
    parentOf = new Map();
    const addChild = (parent, id) => {
      const key = parent || '';
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(id);
      parentOf.set(id, parent || null);
    };
    const g = state.grouping;
    for (const s of data.symbols) {
      let parent = null;
      if (g !== 'none') {
        const slash = s.file.lastIndexOf('/');
        const dir = slash >= 0 ? s.file.slice(0, slash) : '';
        let folderId = null;
        if (g === 'folder') {
          folderId = 'folder:' + dir;
          if (!groups.has(folderId)) {
            groups.set(folderId, { id: folderId, label: dir || '(workspace root)', kind: 'folder' });
            addChild(null, folderId);
          }
        }
        const fileId = 'file:' + s.file;
        if (!groups.has(fileId)) {
          groups.set(fileId, { id: fileId, label: g === 'folder' ? s.file.slice(slash + 1) : s.file, kind: 'file' });
          addChild(folderId, fileId);
        }
        parent = fileId;
      }
      if (s.owner && symbolsById.has(s.owner)) parent = s.owner;
      addChild(parent, s.id);
    }
  }

  const isContainer = (id) => groups.has(id) || (children.get(id) || []).length > 0;
  const labelOf = (id) => (symbolsById.has(id) ? symbolsById.get(id).name : groups.has(id) ? groups.get(id).label : id);
  const kindOf = (id) => (symbolsById.get(id) || groups.get(id)).kind;

  function ancestors(id) {
    const chain = [];
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) chain.unshift(p);
    return chain;
  }

  function isHidden(id) {
    for (let x = id; x; x = parentOf.get(x)) if (state.hidden.has(x)) return true;
    return false;
  }

  /** The node that stands in for a symbol: its outermost collapsed ancestor, or itself. */
  function representative(id) {
    for (const a of ancestors(id)) if (state.collapsed.has(a)) return a;
    return id;
  }

  function countSymbols(id) {
    let n = 0;
    for (const c of children.get(id) || []) n += (symbolsById.has(c) ? 1 : 0) + countSymbols(c);
    return n;
  }

  // ---------------------------------------------------------------------------
  // Elements

  const measure = document.createElement('canvas').getContext('2d');
  function textWidth(text, font) {
    measure.font = font;
    return measure.measureText(text).width;
  }

  const baseName = (file) => file.slice(file.lastIndexOf('/') + 1);
  let duplicateNames = new Set();

  function buildElements() {
    const nodes = new Map();
    const addNode = (id) => {
      if (nodes.has(id)) return;
      const chain = ancestors(id);
      const parent = chain[chain.length - 1];
      if (parent) addNode(parent);
      const sym = symbolsById.get(id);
      const collapsed = state.collapsed.has(id) && isContainer(id);
      let label = labelOf(id);
      if (sym && state.grouping === 'none' && duplicateNames.has(sym.name)) {
        const hint = sym.detail && sym.detail.length <= 30 ? sym.detail : baseName(sym.file);
        label += ` (${hint})`;
      }
      if (collapsed) label += `  +${countSymbols(id)}`;
      const font = sym ? `12px ${colors.codeFont}` : `12px ${colors.uiFont}`;
      nodes.set(id, {
        id,
        parent,
        label,
        kind: kindOf(id),
        collapsed,
        root: !!(sym && sym.root),
        w: Math.ceil(textWidth(label, font)) + 22,
      });
    };
    for (const s of data.symbols) {
      if (!isHidden(s.id)) addNode(representative(s.id));
    }

    const edges = new Map();
    for (const e of data.edges) {
      const category = e.kind === 'calls' ? 'calls' : e.kind === 'references' ? 'references' : 'inherit';
      if (!state.edges[category] || isHidden(e.source) || isHidden(e.target)) continue;
      const s = representative(e.source);
      const t = representative(e.target);
      if (s === t || ancestors(s).includes(t) || ancestors(t).includes(s)) continue;
      const key = `${s}\u0000${t}\u0000${e.kind}`;
      const existing = edges.get(key);
      if (existing) existing.count++;
      else edges.set(key, { id: 'e' + edges.size, source: s, target: t, kind: e.kind, count: 1 });
    }
    for (const e of edges.values()) e.width = e.count > 1 ? Math.min(1.3 + Math.log2(e.count), 5) : 1.3;
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  function savePositions() {
    if (!cy) return;
    cy.nodes().forEach((n) => positions.set(n.id(), Object.assign({}, n.position())));
  }

  function render(options) {
    const opts = options || {};
    const { nodes, edges } = buildElements();
    savePositions();
    cy.batch(() => {
      cy.elements().remove();
      cy.add(nodes.map((d) => ({ group: 'nodes', data: d })));
      cy.add(edges.map((d) => ({ group: 'edges', data: d })));
    });

    // Put nodes back where they were; new ones start next to their nearest known ancestor.
    const leaves = cy.nodes().filter((n) => n.isChildless());
    let missing = 0;
    leaves.forEach((n) => {
      const known = positions.get(n.id());
      if (known) {
        n.position(known);
        return;
      }
      missing++;
      const anchor = ancestors(n.id()).reverse().map((a) => positions.get(a)).find(Boolean);
      if (anchor) n.position({ x: anchor.x + (Math.random() - 0.5) * 60, y: anchor.y + (Math.random() - 0.5) * 60 });
    });

    if (opts.layout === 'full' || (missing > 0 && missing === leaves.length)) runLayout(true);
    else if (missing > 0) runLayout(false);

    applyHighlight();
    applyFind();
    renderOutline();
    updateToolbar();
  }

  // ---------------------------------------------------------------------------
  // Layout

  const useTree = () => data && data.mode !== 'files' && state.grouping === 'none';

  /** Left-to-right layers for call graphs: callers, then the root, then what it calls. */
  function treePositions() {
    const rootNode = cy.nodes('[?root]')[0] || cy.nodes()[0];
    const level = new Map([[rootNode.id(), 0]]);
    const walk = (dir) => {
      let frontier = [rootNode];
      let depth = 0;
      while (frontier.length) {
        depth += dir;
        const next = [];
        for (const n of frontier) {
          const neighbours = dir > 0 ? n.outgoers('node') : n.incomers('node');
          neighbours.forEach((m) => {
            if (!level.has(m.id())) {
              level.set(m.id(), depth);
              next.push(m);
            }
          });
        }
        frontier = next;
      }
    };
    walk(1);
    walk(-1);
    const maxLevel = Math.max(0, ...level.values());
    cy.nodes().forEach((n) => { if (!level.has(n.id())) level.set(n.id(), maxLevel + 1); });

    const columns = new Map();
    for (const [id, l] of level) {
      if (!columns.has(l)) columns.set(l, []);
      columns.get(l).push(cy.getElementById(id));
    }
    const order = [...columns.keys()].sort((a, b) => a - b);
    const gapX = 70;
    const rowH = 38;
    const pos = {};
    let x = 0;
    let prevHalf = 0;
    order.forEach((l, i) => {
      const col = columns.get(l);
      const half = Math.max(...col.map((n) => n.width())) / 2;
      x += i === 0 ? 0 : prevHalf + gapX + half;
      col.forEach((n, j) => { pos[n.id()] = { x, y: (j - (col.length - 1) / 2) * rowH }; });
      prevHalf = half;
    });
    return pos;
  }

  function runLayout(fromScratch) {
    const animate = !reduceMotion && cy.nodes().length < 500;
    let options;
    if (useTree()) {
      const pos = treePositions();
      options = { name: 'preset', positions: (n) => pos[n.id()], fit: true, padding: 40, animate, animationDuration: 300 };
    } else {
      options = {
        name: hasFcose ? 'fcose' : 'cose',
        quality: fromScratch ? 'default' : 'proof',
        randomize: fromScratch,
        animate,
        animationDuration: 400,
        fit: fromScratch,
        padding: 30,
        nodeDimensionsIncludeLabels: true,
        packComponents: true,
        nodeRepulsion: () => 9000,
        idealEdgeLength: () => 80,
        edgeElasticity: () => 0.45,
        nestingFactor: 0.2,
        gravity: 0.35,
        numIter: 2500,
        tile: true,
        tilingPaddingVertical: 14,
        tilingPaddingHorizontal: 14,
      };
    }
    const layout = cy.layout(options);
    layout.one('layoutstop', savePositions);
    layout.run();
  }

  // ---------------------------------------------------------------------------
  // Selection, tracing and find

  function applyHighlight() {
    cy.elements().removeClass('faded in out focus');
    const node = state.selected ? cy.getElementById(state.selected) : null;
    if (!node || node.empty()) return;
    const core = node.union(node.descendants());
    const out = core.outgoers('edge').filter((e) => !core.contains(e.target()));
    const inc = core.incomers('edge').filter((e) => !core.contains(e.source()));
    const keep = core.union(core.edgesWith(core)).union(out).union(inc).union(out.targets()).union(inc.sources());
    cy.elements().not(keep.union(keep.ancestors())).addClass('faded');
    out.addClass('out');
    inc.addClass('in');
    node.addClass('focus');
  }

  function select(id, opts) {
    state.selected = id;
    applyHighlight();
    document.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
    if (id) {
      const row = document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
      if (row) {
        row.classList.add('selected');
        row.scrollIntoView({ block: 'nearest' });
      }
      if (opts && opts.center) {
        const n = cy.getElementById(id);
        if (n.nonempty()) cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 0.9) }, { duration: reduceMotion ? 0 : 250 });
      }
    }
    showStatus(id);
    $('status-hint').textContent = !id
      ? 'Click to trace links. Double-click to open or expand. Right-click for more.'
      : symbolsById.has(id)
        ? 'Blue links: what it uses. Green links: what uses it. Press Enter to open.'
        : 'Blue links: what it uses. Green links: what uses it. Press C to collapse or expand.';
  }

  /** Select a symbol, expanding any collapsed groups around it first. */
  function reveal(id) {
    const hiddenNow = isHidden(id);
    const blockers = ancestors(id).filter((a) => state.collapsed.has(a));
    if (!hiddenNow && blockers.length) {
      blockers.forEach((a) => state.collapsed.delete(a));
      render();
    }
    select(id, { center: !hiddenNow });
  }

  function matches() {
    const q = state.query.trim().toLowerCase();
    if (!q) return null;
    return new Set(data.symbols.filter((s) => s.name.toLowerCase().includes(q)).map((s) => s.id));
  }

  function applyFind() {
    cy.nodes().removeClass('match');
    const m = matches();
    if (!m) return;
    for (const id of m) if (!isHidden(id)) cy.getElementById(representative(id)).addClass('match');
  }

  function openSymbol(id) {
    const s = symbolsById.get(id);
    if (s) vscode.postMessage({ type: 'reveal', uri: s.uri, range: s.range });
  }

  function toggleCollapse(id) {
    if (!isContainer(id)) return;
    if (state.collapsed.has(id)) state.collapsed.delete(id);
    else {
      state.collapsed.add(id);
      if (state.selected && ancestors(state.selected).includes(id)) state.selected = id;
    }
    render();
  }

  function setAllCollapsed(collapse) {
    state.collapsed.clear();
    if (collapse) {
      const kind = state.grouping === 'none' ? null : state.grouping === 'folder' ? 'folder' : 'file';
      if (kind) {
        for (const g of groups.values()) if (g.kind === kind) state.collapsed.add(g.id);
      } else {
        for (const s of data.symbols) if (isContainer(s.id)) state.collapsed.add(s.id);
      }
    }
    render();
  }

  function hide(id) {
    state.hidden.add(id);
    if (state.selected && (state.selected === id || ancestors(state.selected).includes(id))) state.selected = null;
    render();
  }

  /** Hide every symbol that is not the given one, inside it, or directly linked to it. */
  function showOnlyNeighbourhood(id) {
    const inside = new Set([id]);
    const stack = [id];
    while (stack.length) for (const c of children.get(stack.pop()) || []) { inside.add(c); stack.push(c); }
    const keep = new Set(inside);
    for (const e of data.edges) {
      if (inside.has(e.source)) keep.add(e.target);
      if (inside.has(e.target)) keep.add(e.source);
    }
    // Classes that contain a kept member stay visible as containers.
    const visible = new Set(keep);
    for (const k of keep) {
      for (const a of ancestors(k)) {
        visible.add(a);
        state.collapsed.delete(a);
      }
    }
    state.hidden.clear();
    for (const s of data.symbols) if (!visible.has(s.id)) state.hidden.add(s.id);
    state.selected = id;
    render({ layout: 'full' });
  }

  // ---------------------------------------------------------------------------
  // Outline (mirrors the graph)

  function renderOutline() {
    const root = $('outline');
    root.textContent = '';
    if (!data) return;
    const m = matches();
    let shown = null;
    if (m) {
      shown = new Set();
      for (const id of m) { shown.add(id); ancestors(id).forEach((a) => shown.add(a)); }
    }
    const frag = document.createDocumentFragment();
    const walk = (key, depth) => {
      for (const id of children.get(key) || []) {
        if (shown && !shown.has(id)) continue;
        frag.appendChild(makeRow(id, depth));
        if (isContainer(id) && (shown || !state.collapsed.has(id))) walk(id, depth + 1);
      }
    };
    walk('', 0);
    root.appendChild(frag);
    if (m && m.size === 0) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.padding = '6px 10px';
      p.textContent = 'No symbols match.';
      root.appendChild(p);
    }
  }

  function makeRow(id, depth) {
    const row = document.createElement('div');
    const isGroup = groups.has(id);
    const hiddenItem = isHidden(id);
    row.className = 'row' + (isGroup ? ` group ${groups.get(id).kind}` : '') + (hiddenItem ? ' hidden-item' : '') + (state.selected === id ? ' selected' : '');
    row.dataset.id = id;
    row.style.paddingLeft = 4 + depth * 12 + 'px';
    row.title = symbolsById.has(id) ? symbolsById.get(id).file : labelOf(id);

    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.textContent = isContainer(id) ? (state.collapsed.has(id) ? '\u25B8' : '\u25BE') : '';
    const dot = document.createElement('span');
    dot.className = 'dot ' + kindOf(id);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = labelOf(id);
    if (state.grouping === 'none' && symbolsById.has(id) && !symbolsById.get(id).owner) {
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = baseName(symbolsById.get(id).file);
      name.append(' ', where);
    }
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.textContent = state.hidden.has(id) ? 'Show' : 'Hide';
    eye.setAttribute('aria-label', `${eye.textContent} ${labelOf(id)}`);
    row.append(twisty, dot, name, eye);
    return row;
  }

  $('outline').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.classList.contains('eye')) {
      if (state.hidden.has(id)) state.hidden.delete(id);
      else state.hidden.add(id);
      render();
    } else if (e.target.classList.contains('twisty') && isContainer(id)) {
      toggleCollapse(id);
    } else {
      reveal(id);
    }
  });
  $('outline').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (row && !e.target.classList.contains('eye')) {
      if (symbolsById.has(row.dataset.id)) openSymbol(row.dataset.id);
      else toggleCollapse(row.dataset.id);
    }
  });

  // ---------------------------------------------------------------------------
  // Toolbar, status line, notes

  function updateToolbar() {
    document.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.group === state.grouping)));
    const n = state.hidden.size;
    const btn = $('show-hidden');
    btn.hidden = n === 0;
    btn.textContent = `Show ${n} hidden`;
    if (data) $('counts').textContent = `${data.symbols.length} symbols, ${data.edges.length} links`;
    const present = { calls: true, inherit: false, references: false };
    for (const e of data ? data.edges : []) {
      if (e.kind === 'references') present.references = true;
      else if (e.kind !== 'calls') present.inherit = true;
    }
    document.querySelectorAll('[data-edges]').forEach((input) => {
      input.parentElement.hidden = !present[input.dataset.edges];
    });
    $('toggle-outline').setAttribute('aria-pressed', String(state.outline));
    document.querySelector('.body').classList.toggle('no-outline', !state.outline);
  }

  function showStatus(id) {
    const el = $('status-symbol');
    el.textContent = '';
    if (!id || !data) return;
    const s = symbolsById.get(id);
    const part = (text, tag) => {
      const span = document.createElement(tag || 'span');
      span.textContent = text;
      el.appendChild(span);
    };
    if (s) {
      part(s.kind, 'span');
      part(s.name, 'code');
      part(`${s.file}:${s.range[0] + 1}`);
      if (s.detail) part(s.detail);
    } else if (groups.has(id)) {
      part(groups.get(id).kind);
      part(groups.get(id).label, 'code');
      part(`${countSymbols(id)} symbols`);
    }
  }

  function showNotes(notes) {
    const box = $('notes');
    box.textContent = '';
    box.hidden = !notes.length;
    if (!notes.length) return;
    const ul = document.createElement('ul');
    for (const n of notes) {
      const li = document.createElement('li');
      li.textContent = n;
      ul.appendChild(li);
    }
    const close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => { box.hidden = true; });
    box.append(ul, close);
  }

  document.querySelectorAll('[data-group]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!data || state.grouping === b.dataset.group) return;
      state.grouping = b.dataset.group;
      if (data.mode === 'files') { saved.grouping = state.grouping; persist(); }
      buildStructure();
      for (const id of [...state.collapsed]) if (!isContainer(id)) state.collapsed.delete(id);
      for (const id of [...state.hidden]) if (!symbolsById.has(id) && !groups.has(id)) state.hidden.delete(id);
      if (state.selected && !symbolsById.has(state.selected) && !groups.has(state.selected)) state.selected = null;
      render({ layout: 'full' });
    }),
  );
  document.querySelectorAll('[data-edges]').forEach((input) =>
    input.addEventListener('change', () => {
      state.edges[input.dataset.edges] = input.checked;
      if (data) render();
    }),
  );
  $('find').addEventListener('input', (e) => {
    state.query = e.target.value;
    if (!data) return;
    applyFind();
    renderOutline();
  });
  $('find').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const m = matches();
      const first = m && [...m].find((id) => !isHidden(id));
      if (first) reveal(first);
    } else if (e.key === 'Escape') {
      e.target.value = '';
      e.target.dispatchEvent(new Event('input'));
    }
  });
  $('show-hidden').addEventListener('click', () => { state.hidden.clear(); render(); });
  $('fit').addEventListener('click', () => cy.animate({ fit: { padding: 30 } }, { duration: reduceMotion ? 0 : 250 }));
  $('relayout').addEventListener('click', () => data && runLayout(true));
  $('toggle-outline').addEventListener('click', () => {
    state.outline = !state.outline;
    persist();
    updateToolbar();
    requestAnimationFrame(() => cy.resize());
  });

  // ---------------------------------------------------------------------------
  // Context menu

  const menu = $('menu');
  function hideMenu() { menu.hidden = true; }

  function showMenu(id, at) {
    const items = [];
    if (id) {
      const sym = symbolsById.has(id);
      if (sym) items.push(['Open in editor', () => openSymbol(id)]);
      if (isContainer(id)) items.push([state.collapsed.has(id) ? 'Expand' : 'Collapse', () => toggleCollapse(id)]);
      items.push(['Show only this and its links', () => showOnlyNeighbourhood(id)]);
      items.push(['Hide', () => hide(id)]);
      items.push(null);
    }
    items.push(['Expand all', () => setAllCollapsed(false)]);
    items.push([state.grouping === 'none' ? 'Collapse all classes' : `Collapse all ${state.grouping === 'folder' ? 'folders' : 'files'}`, () => setAllCollapsed(true)]);
    items.push(['Arrange again', () => runLayout(true)]);

    menu.textContent = '';
    for (const item of items) {
      if (!item) { menu.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitem');
      b.textContent = item[0];
      b.addEventListener('click', () => { hideMenu(); item[1](); });
      menu.appendChild(b);
    }
    menu.hidden = false;
    const stage = menu.parentElement.getBoundingClientRect();
    menu.style.left = Math.min(at.x, stage.width - menu.offsetWidth - 4) + 'px';
    menu.style.top = Math.min(at.y, stage.height - menu.offsetHeight - 4) + 'px';
    menu.querySelector('button').focus();
  }

  document.addEventListener('mousedown', (e) => { if (!menu.contains(e.target)) hideMenu(); });
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('button')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { hideMenu(); $('cy').focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
  });

  // ---------------------------------------------------------------------------
  // Graph setup and events

  colors = readColors();
  cy = cytoscape({
    container: $('cy'),
    style: stylesheet(),
    minZoom: 0.05,
    maxZoom: 3,
    boxSelectionEnabled: false,
    selectionType: 'single',
  });

  cy.on('tap', 'node', (e) => { hideMenu(); select(e.target.id()); });
  cy.on('tap', (e) => { if (e.target === cy) { hideMenu(); select(null); } });
  cy.on('dbltap', 'node', (e) => {
    const n = e.target;
    if (n.isParent() || state.collapsed.has(n.id()) || groups.has(n.id())) toggleCollapse(n.id());
    else openSymbol(n.id());
  });
  cy.on('cxttap', (e) => {
    const id = e.target === cy ? null : e.target.isNode() ? e.target.id() : null;
    if (id) select(id);
    showMenu(id, e.renderedPosition);
  });
  cy.on('mouseover', 'node', (e) => showStatus(e.target.id()));
  cy.on('mouseout', 'node', () => showStatus(state.selected));
  cy.on('free', 'node', savePositions);
  cy.on('zoom pan', hideMenu);

  document.addEventListener('keydown', (e) => {
    if (!data || e.target.closest('input, .menu') || e.metaKey || e.ctrlKey || e.altKey) return;
    const id = state.selected;
    if (e.key === 'Enter' && id) openSymbol(id);
    else if ((e.key === 'h' || e.key === 'Delete') && id) hide(id);
    else if (e.key === 'c' && id) toggleCollapse(id);
    else if (e.key === 'f') $('fit').click();
    else if (e.key === 'l') runLayout(true);
    else if (e.key === 'Escape') select(null);
    else if (e.key === '/') { e.preventDefault(); $('find').focus(); }
  });

  // Theme switches change the body class and the variables on <html>; re-read colours then.
  const themeObserver = new MutationObserver(() => {
    colors = readColors();
    cy.style(stylesheet());
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---------------------------------------------------------------------------
  // Messages from the extension

  function loadGraph(d) {
    data = d;
    symbolsById = new Map(d.symbols.map((s) => [s.id, s]));
    const seen = new Set();
    duplicateNames = new Set();
    for (const s of d.symbols) (seen.has(s.name) ? duplicateNames : seen).add(s.name);
    positions.clear();
    state.collapsed.clear();
    state.hidden.clear();
    state.grouping = d.mode === 'files' ? saved.grouping || 'file' : 'none';
    const root = d.symbols.find((s) => s.root);
    state.selected = root ? root.id : null;
    buildStructure();

    const notes = d.notes.slice();
    if (d.mode === 'files' && d.symbols.length > 250 && state.grouping !== 'none') {
      for (const g of groups.values()) if (g.kind === 'file') state.collapsed.add(g.id);
      notes.push('This is a large graph, so files start collapsed. Double-click a file to open it up.');
    }
    showNotes(notes);

    $('title').textContent = d.title;
    const empty = $('empty');
    empty.hidden = d.symbols.length > 0;
    if (!d.symbols.length) {
      empty.innerHTML = '<p class="empty-title">Nothing to draw</p><p>No functions, classes or interfaces were found in the selection.</p>';
    }
    render({ layout: 'full' });
    select(state.selected);
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'graph') loadGraph(msg.data);
  });

  updateToolbar();
  vscode.postMessage({ type: 'ready' });
  window.__asterism = { loadGraph, state, get cy() { return cy; } }; // handy for debugging in devtools
})();
