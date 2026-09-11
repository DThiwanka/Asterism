// Builds preview/index.html: the real webview markup and scripts, with a
// VS Code Dark Modern colour set, fed with sample data. Open it in a browser.
const fs = require('fs');
const path = require('path');
const { BODY } = require('../out/markup.js');

const theme = process.argv[2] === 'light'
  ? `--vscode-editor-background:#ffffff;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-panel-border:#e5e5e5;--vscode-editorWidget-background:#f8f8f8;--vscode-focusBorder:#005fb8;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-activeSelectionBackground:#e8e8e8;--vscode-list-activeSelectionForeground:#000000;--vscode-input-background:#ffffff;--vscode-input-border:#cecece;--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-symbolIcon-functionForeground:#652d90;--vscode-symbolIcon-methodForeground:#652d90;--vscode-symbolIcon-classForeground:#d67e00;--vscode-symbolIcon-interfaceForeground:#007acc;--vscode-symbolIcon-variableForeground:#007acc;--vscode-charts-blue:#1a85ff;--vscode-charts-green:#388a34;--vscode-editorIndentGuide-background1:#d3d3d3;--vscode-textLink-foreground:#005fb8;`
  : `--vscode-editor-background:#1f1f1f;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#2b2b2b;--vscode-editorWidget-background:#202020;--vscode-focusBorder:#0078d4;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#ffffff;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;--vscode-button-background:#0078d4;--vscode-button-foreground:#ffffff;--vscode-symbolIcon-functionForeground:#b180d7;--vscode-symbolIcon-methodForeground:#b180d7;--vscode-symbolIcon-classForeground:#ee9d28;--vscode-symbolIcon-interfaceForeground:#75beff;--vscode-symbolIcon-variableForeground:#75beff;--vscode-charts-blue:#3794ff;--vscode-charts-green:#89d185;--vscode-editorIndentGuide-background1:#404040;--vscode-textLink-foreground:#4daafc;`;

const html = `<!DOCTYPE html>
<html lang="en" style="${theme}--vscode-font-family:-apple-system,'Segoe UI',system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Menlo,Consolas,'DejaVu Sans Mono',monospace;">
<head><meta charset="UTF-8"><title>Asterism preview</title><link rel="stylesheet" href="../media/graph.css"></head>
<body>
${BODY}
<script>window.__posted = [];</script>
<script src="../media/vendor/cytoscape.min.js"></script>
<script src="../media/vendor/layout-base.js"></script>
<script src="../media/vendor/cose-base.js"></script>
<script src="../media/vendor/cytoscape-fcose.js"></script>
<script src="../media/graph.js"></script>
<script src="sample-graph.js"></script>
<script>window.postMessage({ type: 'graph', data: window.SAMPLE_GRAPH }, '*');</script>
</body>
</html>`;
const out = process.argv[2] === 'light' ? 'index-light.html' : 'index.html';
fs.writeFileSync(path.join(__dirname, out), html);
console.log(`Wrote preview/${out}`);
