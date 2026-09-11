// Copies the browser builds of the graph libraries into media/vendor so the
// webview can load them from disk (webviews cannot use node_modules directly).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dest = path.join(root, 'media', 'vendor');
fs.mkdirSync(dest, { recursive: true });

const files = [
  'cytoscape/dist/cytoscape.min.js',
  'layout-base/layout-base.js',
  'cose-base/cose-base.js',
  'cytoscape-fcose/cytoscape-fcose.js',
];

for (const rel of files) {
  const src = path.join(root, 'node_modules', rel);
  fs.copyFileSync(src, path.join(dest, path.basename(rel)));
}
console.log(`Copied ${files.length} files to media/vendor`);
