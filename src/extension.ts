import * as vscode from 'vscode';
import { buildCallGraph, buildFilesGraph, expandSelection, itemId, rootItemAt } from './graphBuilder';
import { GraphData } from './model';
import { GraphPanel } from './panel';

function settings() {
  const c = vscode.workspace.getConfiguration('codeAtlas');
  return {
    callDepth: c.get<number>('callDepth', 3),
    maxFiles: c.get<number>('maxFiles', 300),
    exclude: c.get<string>('exclude', '**/{node_modules,.git,dist,out,build,__pycache__,.venv,venv}/**'),
  };
}

export function activate(context: vscode.ExtensionContext) {
  const showGraph = (data: GraphData) => {
    const panel = GraphPanel.show(context.extensionUri);
    panel.setTitle(data.title);
    panel.post({ type: 'graph', data });
  };

  // --- Graph for files and folders selected in the Explorer ----------------
  const graphSelection = (withVariables: boolean) => async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
    let uris = selected?.length ? selected : clicked ? [clicked] : [];
    if (!uris.length) {
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active && active.scheme === 'file') uris = [active];
    }
    if (!uris.length) {
      uris =
        (await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: 'Create graph',
        })) ?? [];
    }
    if (!uris.length) return;

    const cfg = settings();
    const opts = { withVariables, maxFiles: cfg.maxFiles, exclude: cfg.exclude };
    const data = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Code Atlas', cancellable: true },
      async (progress, token) => {
        progress.report({ message: 'Finding files' });
        const { files, skipped } = await expandSelection(uris, opts);
        if (!files.length) {
          void vscode.window.showWarningMessage('Code Atlas found no source files in the selection.');
          return undefined;
        }
        const result = await buildFilesGraph(files, opts, progress, token);
        if (skipped) {
          result.notes.unshift(`${skipped} more files were left out. Raise "codeAtlas.maxFiles" to include them.`);
        }
        return token.isCancellationRequested ? undefined : result;
      },
    );
    if (data) showGraph(data);
  };

  // --- Call hierarchy of the function under the cursor ---------------------
  const graphFunction = async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file and place the cursor on a function name first.');
      return;
    }
    const root = await rootItemAt(editor.document.uri, editor.selection.active);
    if (!root) {
      void vscode.window.showInformationMessage(
        'Place the cursor on the name of a function or method to graph its calls.',
      );
      return;
    }
    const cfg = settings();
    const data = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Code Atlas: following calls from ${root.name}`, cancellable: true },
      (_p, token) => buildCallGraph(root, { outDepth: cfg.callDepth, inDepth: 0, exclude: cfg.exclude }, token),
    );
    showGraph(data);
  };

  // --- Focused symbol graph: follows the cursor ---------------------------
  let following: vscode.Disposable | undefined;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(type-hierarchy) Following cursor';
  status.tooltip = 'Code Atlas is graphing the symbol under the cursor. Click to stop.';
  status.command = 'codeAtlas.toggleFollowCursor';

  const stopFollowing = () => {
    following?.dispose();
    following = undefined;
    status.hide();
  };

  const startFollowing = () => {
    let timer: NodeJS.Timeout | undefined;
    let lastId = '';
    let generation = 0;

    const update = async (editor: vscode.TextEditor | undefined) => {
      if (!editor || editor.document.uri.scheme !== 'file') return;
      const mine = ++generation;
      const root = await rootItemAt(editor.document.uri, editor.selection.active);
      if (!root || mine !== generation) return;
      const id = itemId(root);
      if (id === lastId) return;
      lastId = id;
      const data = await buildCallGraph(root, { outDepth: 1, inDepth: 1, exclude: settings().exclude, maxNodes: 120 });
      if (mine === generation && following) showGraph(data);
    };
    const schedule = (editor: vscode.TextEditor | undefined) => {
      clearTimeout(timer);
      timer = setTimeout(() => void update(editor), 350);
    };

    const panel = GraphPanel.show(context.extensionUri);
    following = vscode.Disposable.from(
      vscode.window.onDidChangeTextEditorSelection((e) => schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(schedule),
      panel.onDidDispose(stopFollowing),
      { dispose: () => clearTimeout(timer) },
    );
    status.show();
    schedule(vscode.window.activeTextEditor);
  };

  context.subscriptions.push(
    status,
    { dispose: stopFollowing },
    vscode.commands.registerCommand('codeAtlas.graphSelection', graphSelection(false)),
    vscode.commands.registerCommand('codeAtlas.graphSelectionWithVariables', graphSelection(true)),
    vscode.commands.registerCommand('codeAtlas.graphFunction', graphFunction),
    vscode.commands.registerCommand('codeAtlas.toggleFollowCursor', () => (following ? stopFollowing() : startFollowing())),
  );
}

export function deactivate() {}
