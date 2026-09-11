import * as vscode from 'vscode';
import { buildCallGraph, buildFilesGraph, expandSelection, itemId, rootItemAt } from './graphBuilder';
import { GraphData } from './model';
import { GraphPanel } from './panel';
import { AsterismViewProvider, SidebarFile } from './sidebar';

function settings() {
  const c = vscode.workspace.getConfiguration('asterism');
  return {
    callDepth: c.get<number>('callDepth', 3),
    maxFiles: c.get<number>('maxFiles', 300),
    exclude: c.get<string>('exclude', '**/{node_modules,.git,dist,out,build,__pycache__,.venv,venv}/**'),
  };
}

export function activate(context: vscode.ExtensionContext) {
  const scanWorkspace = async (): Promise<SidebarFile[]> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) return [];
    const cfg = settings();
    const { files } = await expandSelection(folders.map((folder) => folder.uri), {
      withVariables: false,
      maxFiles: cfg.maxFiles,
      exclude: cfg.exclude,
    });
    return files.map((uri) => {
      const relative = vscode.workspace.asRelativePath(uri, false);
      const slash = relative.lastIndexOf('/');
      return {
        uri: uri.toString(),
        label: slash >= 0 ? relative.slice(slash + 1) : relative,
        path: relative,
      };
    });
  };
  const sidebar = new AsterismViewProvider(scanWorkspace, (uri) => {
    void vscode.commands.executeCommand('asterism.graphFile', uri);
  });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('asterism.graphView', sidebar));

  const showGraph = (data: GraphData) => {
    const panel = GraphPanel.show(context.extensionUri);
    panel.setTitle(data.title);
    panel.post({ type: 'graph', data });
    sidebar.refresh();
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
      { location: vscode.ProgressLocation.Notification, title: 'Asterism', cancellable: true },
      async (progress, token) => {
        progress.report({ message: 'Finding files' });
        const { files, skipped } = await expandSelection(uris, opts);
        if (!files.length) {
          void vscode.window.showWarningMessage('Asterism found no source files in the selection.');
          return undefined;
        }
        const result = await buildFilesGraph(files, opts, progress, token);
        if (skipped) {
          result.notes.unshift(`${skipped} more files were left out. Raise "asterism.maxFiles" to include them.`);
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
      { location: vscode.ProgressLocation.Notification, title: `Asterism: following calls from ${root.name}`, cancellable: true },
      (_p, token) => buildCallGraph(root, { outDepth: cfg.callDepth, inDepth: 0, exclude: cfg.exclude }, token),
    );
    showGraph(data);
  };

  // --- Focused symbol graph: follows the cursor ---------------------------
  let following: vscode.Disposable | undefined;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(type-hierarchy) Following cursor';
  status.tooltip = 'Asterism is graphing the symbol under the cursor. Click to stop.';
  status.command = 'asterism.toggleFollowCursor';

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
    vscode.commands.registerCommand('asterism.openGraph', () => {
      if (GraphPanel.current) {
        GraphPanel.current.reveal();
      } else {
        void vscode.window.showInformationMessage('Create a graph first, then open it from the Asterism sidebar.');
      }
    }),
    vscode.commands.registerCommand('asterism.graphFile', (uri: string) =>
      graphSelection(false)(vscode.Uri.parse(uri)),
    ),
    vscode.commands.registerCommand('asterism.graphWorkspace', () =>
      graphSelection(false)(undefined, (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)),
    ),
    vscode.commands.registerCommand('asterism.graphSelection', graphSelection(false)),
    vscode.commands.registerCommand('asterism.graphSelectionWithVariables', graphSelection(true)),
    vscode.commands.registerCommand('asterism.graphFunction', graphFunction),
    vscode.commands.registerCommand('asterism.toggleFollowCursor', () => (following ? stopFollowing() : startFollowing())),
  );

  let refreshTimer: NodeJS.Timeout | undefined;
  const refreshSidebar = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void sidebar.refresh(), 250);
  };
  context.subscriptions.push(
    vscode.workspace.onDidCreateFiles(refreshSidebar),
    vscode.workspace.onDidDeleteFiles(refreshSidebar),
    vscode.workspace.onDidRenameFiles(refreshSidebar),
    vscode.workspace.onDidChangeTextDocument(refreshSidebar),
    { dispose: () => clearTimeout(refreshTimer) },
  );
}

export function deactivate() {}
