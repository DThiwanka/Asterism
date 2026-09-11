/** Static webview markup. Kept free of the vscode import so preview/build-preview.js can use it too. */
export const BODY = /* html */ `
<header class="toolbar">
  <div class="title"><span id="title">Code Atlas</span><span id="counts" class="counts"></span></div>
  <div class="segmented" role="radiogroup" aria-label="Group by">
    <span class="segmented-label">Group by</span>
    <button role="radio" data-group="folder">Folder</button>
    <button role="radio" data-group="file">File</button>
    <button role="radio" data-group="none">None</button>
  </div>
  <div class="edge-filters" aria-label="Show links">
    <label title="Function calls"><input type="checkbox" data-edges="calls" checked><i class="sample calls"></i>Calls</label>
    <label title="Extends and implements"><input type="checkbox" data-edges="inherit" checked><i class="sample inherit"></i>Inheritance</label>
    <label title="Functions that use a variable"><input type="checkbox" data-edges="references" checked><i class="sample references"></i>Variables</label>
  </div>
  <div class="actions">
  <input id="find" type="search" placeholder="Find symbol" aria-label="Find symbol" spellcheck="false">
  <button id="show-hidden" class="text-button" hidden></button>
  <button id="fit" class="icon-button" title="Fit graph to view (F)" aria-label="Fit graph to view"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4"/></svg></button>
  <button id="relayout" class="icon-button" title="Arrange again (L)" aria-label="Arrange again"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.9h-2.9"/></svg></button>
  <button id="toggle-outline" class="icon-button" title="Show or hide outline" aria-label="Show or hide outline" aria-pressed="true"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3.5h12M5 8h9M5 12.5h9M2 8h.01M2 12.5h.01"/></svg></button>
  </div>
</header>
<main class="body">
  <nav id="outline" class="outline" aria-label="Outline"></nav>
  <section class="stage">
    <div id="notes" class="notes" hidden></div>
    <div id="cy" class="cy" tabindex="0" aria-label="Code graph"></div>
    <div id="empty" class="empty">
      <p class="empty-title">No graph yet</p>
      <p>In the Explorer, select files or folders, right-click and choose
      <strong>Code Atlas: Create graph for selected files</strong>.
      Or right-click a function in the editor and choose <strong>Graph calls from this function</strong>.</p>
    </div>
    <div id="menu" class="menu" role="menu" hidden></div>
  </section>
</main>
<footer class="status">
  <span id="status-symbol"></span>
  <span id="status-hint" class="hint">Click to trace links. Double-click to open or expand. Right-click for more.</span>
</footer>
`;
