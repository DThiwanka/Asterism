# Code Atlas

A VS Code extension that draws an interactive diagram of your code: which functions call which, which classes extend or implement which, and which functions use which variables. It works for any language that has a language extension installed (TypeScript, JavaScript, Python, Java, C#, C++, Go, Rust and more), because it never parses code itself.

## Run it

```bash
npm install
npm run compile
```

Open this folder in VS Code and press F5. A second VS Code window (the Extension Development Host) opens with Code Atlas loaded. Open any project in that window, then try the three ways to make a graph.

In the Explorer, select files or folders, right-click and choose **Create graph for selected files**. The "with variables" version also links functions to the top-level variables and class fields they use.

In the editor, put the cursor on a function name, right-click and choose **Graph calls from this function**. It follows calls to the depth set in `codeAtlas.callDepth` (3 by default).

From the Command Palette, run **Code Atlas: Toggle focused symbol graph**. The graph now follows your cursor and shows the callers and callees of whatever function you are in. Click the status bar item to stop.

To work on the graph UI without launching VS Code, run `npm run preview` and open `preview/index.html` (or `index-light.html`) in a browser. It loads the real webview code with sample data.

## Using the graph

Click a node to trace it: blue links are what it uses, green links are what uses it, and everything unrelated fades. Double-click a function to jump to it in the editor, or double-click a file, folder or class to collapse it into a single node (and again to expand). Right-click for more: open, collapse, hide, or show only this node and its direct links.

The toolbar switches grouping between folder, file and none, filters link types, and finds symbols by name. The outline on the left mirrors the graph; its arrows collapse and expand, and its Hide/Show buttons remove things from the graph. Keyboard: Enter opens, C collapses, H hides, F fits, L arranges again, / jumps to Find, Escape clears the selection.

Graphs with more than 250 symbols open with files collapsed so they stay readable.

## How it works

`src/graphBuilder.ts` does all the analysis through VS Code's built-in provider commands, which are answered by whatever language server is installed:

| Step | Command |
| --- | --- |
| Find classes, functions, methods, variables in each file | `vscode.executeDocumentSymbolProvider` |
| Find what each function calls | `vscode.prepareCallHierarchy` + `vscode.provideOutgoingCalls` |
| Find callers (focus mode) | `vscode.provideIncomingCalls` |
| Find base classes and interfaces | `vscode.prepareTypeHierarchy` + `vscode.provideSupertypes` |
| Same, for languages without type hierarchy (e.g. TypeScript) | Read the class header text, then `vscode.executeDefinitionProvider` on each base name |
| Find which functions use a variable | `vscode.executeReferenceProvider` |

Every call target, definition and reference is mapped back to a graph node by finding the innermost symbol whose range contains that position. A few details worth knowing: `const f = () => {}` is reported as a variable by most language servers, so each top-level variable is probed with `prepareCallHierarchy` to see whether it is really a function; and language servers often return nothing while a project is still loading, so the first file of each language is retried a few times.

`src/panel.ts` hosts the webview. `media/graph.js` draws the graph with [Cytoscape.js](https://js.cytoscape.org) and the fCoSE layout, which handles nested groups well. Call graphs without grouping use a simple left-to-right layered layout instead: callers, then the function, then what it calls. All colours come from the active VS Code theme, including the symbol icon colours, so the graph matches light, dark and high-contrast themes.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `codeAtlas.callDepth` | 3 | Levels of calls to follow from a single function |
| `codeAtlas.maxFiles` | 300 | Most files included from a selection |
| `codeAtlas.exclude` | node_modules, .git, dist, out, build, venvs | Files skipped when expanding folders and following calls |

## Ideas for next steps

Custom logical groups (let the user select nodes and name a group), saved views per workspace, export to SVG or PNG (`cy.png()` / `cy.svg()` via the cytoscape-svg plugin), showing calls into external libraries as faded leaf nodes, and caching symbol results keyed by document version so re-graphing a large folder is instant. If you plan to sell it with limits like Atomic Viz does, the natural place to enforce them is `expandSelection` (file count) and `buildCallGraph` (depth), with license checks kept on a server you control.

## Publishing

Set `publisher` in `package.json`, then `npm run package` to build a `.vsix` with `@vscode/vsce`, and follow the [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) to put it on the Marketplace.
