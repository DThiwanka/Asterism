# Asterism

Asterism is a VS Code extension that helps you understand a codebase. It turns code relationships into an interactive graph.

It can show:

- Which functions call other functions
- Which classes extend other classes
- Which classes implement interfaces
- Which functions use variables
- Which files and folders contain each symbol

Asterism does not need its own parser for every language. It uses the language support already installed in VS Code, so it can work with TypeScript, JavaScript, Python, Java, C#, C++, Go, Rust, and other supported languages.

## Quick start

1. Install the Asterism `.vsix` file, or start the project with `F5`.
2. Open a project that has a VS Code language extension installed.
3. Click the **Asterism** icon in the Activity Bar.
4. Asterism scans the workspace and shows its folders and files.
5. Search for a file or expand a folder.
6. Click a file to open its graph in the main editor area.

The sidebar also has **Graph entire workspace** for a project-wide graph. Use **Refresh files** after a large change if you want to scan immediately. Asterism also refreshes the file list when files are created, changed, renamed, or deleted.

## Other ways to create a graph

- In the Explorer, right-click files or folders and choose **Create graph for selected files**.
- In the editor, right-click a function and choose **Graph calls from this function**.
- From the Command Palette, run **Asterism: Toggle focused symbol graph** to follow the symbol under the cursor.

To develop the extension:

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5`. A new Extension Development Host window opens with Asterism loaded.

To preview the graph UI in a browser, run `npm run preview` and open `preview/index.html` or `preview/index-light.html`.

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
| `asterism.callDepth` | 3 | Levels of calls to follow from a single function |
| `asterism.maxFiles` | 300 | Most files included from a selection |
| `asterism.exclude` | node_modules, .git, dist, out, build, venvs | Files skipped when expanding folders and following calls |

## Project status

Asterism includes an Activity Bar sidebar, automatic workspace scanning, a folder and file tree, file search, refresh support, graph grouping, graph filtering, symbol tracing, source navigation, and light, dark, and high-contrast theme support.

The graph uses Cytoscape.js and the fCoSE layout. The extension uses VS Code language-server commands for symbol, call, type, definition, and reference information.

The project was developed from an original idea and technical direction by Dulaj Thiwanka, with GPT-5.6 LUNA Agentic Coding used as a development assistant. The architecture, feature choices, integration, branding, testing, packaging, and release work were directed as part of the project development.

## Possible future improvements

Custom logical groups (let the user select nodes and name a group), saved views per workspace, export to SVG or PNG (`cy.png()` / `cy.svg()` via the cytoscape-svg plugin), showing calls into external libraries as faded leaf nodes, and caching symbol results keyed by document version so re-graphing a large folder is instant. If you plan to sell it with limits like Atomic Viz does, the natural place to enforce them is `expandSelection` (file count) and `buildCallGraph` (depth), with license checks kept on a server you control.

## Publishing

Set `publisher` in `package.json`, then `npm run package` to build a `.vsix` with `@vscode/vsce`.

GitHub can save release packages automatically. First commit and push the version change, then create and push a matching tag:

```bash
git add .
git commit -m "chore: prepare Asterism 1.2.0 release"
git push origin main
git tag v1.2.0
git push origin v1.2.0
```

The GitHub Actions workflow checks that the tag matches the version in `package.json`, compiles the extension, creates `asterism-1.2.0.vsix`, and attaches it to a new GitHub Release. It does not publish to the VS Code Marketplace; Marketplace publishing still needs a publisher token.

For Marketplace publishing, follow the [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
