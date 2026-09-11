import * as vscode from 'vscode';
import { BODY } from './markup';
import { FromWebview, ToWebview } from './model';

/** The single Code Atlas panel. New graphs replace the current one. */
export class GraphPanel {
  static current: GraphPanel | undefined;

  private ready = false;
  private queue: ToWebview[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  static show(extensionUri: vscode.Uri): GraphPanel {
    if (GraphPanel.current) {
      GraphPanel.current.panel.reveal(undefined, true);
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeAtlas',
      'Code Atlas',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    GraphPanel.current = new GraphPanel(panel, extensionUri);
    return GraphPanel.current;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    panel.webview.html = this.html(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((msg: FromWebview) => this.handle(msg));
    panel.onDidDispose(() => {
      GraphPanel.current = undefined;
      this.disposeEmitter.fire();
      this.disposeEmitter.dispose();
    });
  }

  post(message: ToWebview) {
    if (this.ready) void this.panel.webview.postMessage(message);
    else this.queue.push(message);
  }

  setTitle(title: string) {
    this.panel.title = `Code Atlas: ${title}`;
  }

  private async handle(msg: FromWebview) {
    if (msg.type === 'ready') {
      this.ready = true;
      for (const m of this.queue.splice(0)) void this.panel.webview.postMessage(m);
    } else if (msg.type === 'reveal') {
      const [sl, sc, el, ec] = msg.range;
      const uri = vscode.Uri.parse(msg.uri);
      // Open the code next to the graph rather than on top of it.
      const codeColumn =
        vscode.window.visibleTextEditors.find((e) => e.viewColumn !== this.panel.viewColumn)?.viewColumn ??
        vscode.ViewColumn.One;
      await vscode.window.showTextDocument(uri, {
        viewColumn: codeColumn,
        selection: new vscode.Range(sl, sc, el, ec),
        preserveFocus: false,
      });
    }
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const media = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', ...p));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const scripts = [
      media('vendor', 'cytoscape.min.js'),
      media('vendor', 'layout-base.js'),
      media('vendor', 'cose-base.js'),
      media('vendor', 'cytoscape-fcose.js'),
      media('graph.js'),
    ];
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${media('graph.css')}">
  <title>Code Atlas</title>
</head>
<body>
${BODY}
${scripts.map((s) => `<script nonce="${nonce}" src="${s}"></script>`).join('\n')}
</body>
</html>`;
  }
}
