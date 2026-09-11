import * as vscode from 'vscode';

export interface SidebarFile {
  uri: string;
  label: string;
  path: string;
}

export class AsterismViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly scan: () => Promise<SidebarFile[]>,
    private readonly openFile: (uri: string) => void,
  ) {}

  async resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview, [], true);
    view.webview.onDidReceiveMessage((message: { command?: string }) => {
      if (message.command === 'scan') void this.refresh();
      else if (message.command?.startsWith('file:')) this.openFile(message.command.slice(5));
    });
    await this.refresh();
  }

  async refresh() {
    if (!this.view) return;
    this.view.webview.html = this.html(this.view.webview, [], true);
    try {
      this.view.webview.html = this.html(this.view.webview, await this.scan(), false);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace scan failed.';
      this.view.webview.html = this.html(this.view.webview, [], false, message);
    }
  }

  private html(webview: vscode.Webview, files: SidebarFile[], loading: boolean, error?: string) {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const rows = loading
      ? '<p class="muted">Scanning workspace...</p>'
      : error
        ? `<p class="error">${this.escape(error)}</p>`
        : files.length
          ? this.tree(files)
          : '<p class="muted">Open a workspace to see its files.</p>';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 10px 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
    h2 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
    p { color: var(--vscode-descriptionForeground); line-height: 1.45; margin: 0 0 10px; }
    button { width: 100%; border: 0; border-radius: 2px; padding: 7px 10px; margin: 4px 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; text-align: left; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #search { width: 100%; box-sizing: border-box; padding: 6px 8px; margin: 4px 0 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    .tree { margin-top: 4px; }
    .folder { margin: 1px 0; }
    .folder > summary { cursor: pointer; padding: 3px 4px; list-style: none; }
    .folder > summary::-webkit-details-marker { display: none; }
    .folder > summary::before { content: '\u25b6'; display: inline-block; width: 16px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .folder[open] > summary::before { content: '\u25bc'; }
    .folder-children { padding-left: 12px; }
    button.file { display: block; color: var(--vscode-foreground); background: transparent; margin: 1px 0; padding: 5px 6px 5px 20px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button.file:hover { background: var(--vscode-list-hoverBackground); }
    .muted { color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
    .hint { margin-top: 14px; font-size: 11px; }
  </style>
</head>
<body>
  <h2>Asterism</h2>
  <p>Workspace files</p>
  <input id="search" type="search" placeholder="Filter files" aria-label="Filter files">
  <button class="secondary" data-command="graphWorkspace">Graph entire workspace</button>
  <button class="secondary" data-command="scan">Refresh files</button>
  <section>${rows}</section>
  <p class="hint">Click a file to open its graph in the main editor area.</p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: button.dataset.command }));
    });
    document.querySelectorAll('[data-uri]').forEach((button) => {
      button.addEventListener('click', () => vscode.postMessage({ command: 'file:' + button.dataset.uri }));
    });
    document.querySelector('#search').addEventListener('input', (event) => {
      const query = event.target.value.toLowerCase();
      document.querySelectorAll('[data-path]').forEach((file) => {
        file.hidden = query && !file.dataset.path.toLowerCase().includes(query);
      });
      document.querySelectorAll('details.folder').forEach((folder) => {
        if (query && folder.textContent.toLowerCase().includes(query)) folder.open = true;
      });
    });
  </script>
</body>
</html>`;
  }

  private tree(files: SidebarFile[]) {
    type Folder = { folders: Map<string, Folder>; files: SidebarFile[] };
    const root: Folder = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/');
      let folder = root;
      for (const part of parts.slice(0, -1)) {
        if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
        folder = folder.folders.get(part)!;
      }
      folder.files.push(file);
    }
    const render = (folder: Folder): string => {
      const folders = [...folder.folders.entries()].sort(([a], [b]) => a.localeCompare(b));
      const nested = folders.map(([name, child]) => `<details class="folder" open><summary>${this.escape(name)}</summary><div class="folder-children">${render(child)}</div></details>`).join('');
      const filesHtml = [...folder.files].sort((a, b) => a.label.localeCompare(b.label)).map((file) => `<button class="file" data-uri="${this.escape(file.uri)}" data-path="${this.escape(file.path)}" title="${this.escape(file.path)}">${this.escape(file.label)}</button>`).join('');
      return nested + filesHtml;
    };
    return `<div class="tree">${render(root)}</div>`;
  }

  private escape(value: string) {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}