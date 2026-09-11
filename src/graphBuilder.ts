import * as vscode from 'vscode';
import { EdgeKind, GraphData, GraphEdge, GraphSymbol, SymbolKindName } from './model';

/*
 * Everything here goes through VS Code's built-in provider commands
 * (document symbols, call hierarchy, type hierarchy, definitions, references).
 * Those are answered by whatever language extension is installed, so the same
 * code works for TypeScript, Python, Java, C++, Go, Rust and so on without
 * writing a parser for each language.
 */

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'java', 'kt', 'kts', 'scala',
  'cs', 'fs', 'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'm', 'mm', 'go', 'rs', 'rb',
  'php', 'swift', 'dart', 'lua', 'vue', 'svelte', 'ex', 'exs', 'clj', 'groovy',
]);

const CALLABLE: ReadonlySet<SymbolKindName> = new Set(['function', 'method']);
const TYPES: ReadonlySet<SymbolKindName> = new Set(['class', 'interface']);

interface Indexed extends GraphSymbol {
  uriObj: vscode.Uri;
  /** Whole body of the symbol, used to find which symbol encloses a position. */
  fullRange: vscode.Range;
  namePos: vscode.Position;
  callItem?: vscode.CallHierarchyItem;
}

export interface BuildOptions {
  withVariables: boolean;
  maxFiles: number;
  exclude: string;
}

type Progress = vscode.Progress<{ message?: string; increment?: number }>;

// ---------------------------------------------------------------------------
// Small helpers

function exec<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  return Promise.resolve(vscode.commands.executeCommand<T>(command, ...args)).catch(() => undefined);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function symbolId(uri: vscode.Uri, name: string, pos: vscode.Position): string {
  return `${uri.toString()}#${name}@${pos.line}:${pos.character}`;
}

function toTuple(r: vscode.Range): [number, number, number, number] {
  return [r.start.line, r.start.character, r.end.line, r.end.character];
}

function relPath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri);
}

/** Runs fn over items with at most `limit` in flight. Stops early on cancellation. */
async function pool<T>(
  items: T[],
  limit: number,
  token: vscode.CancellationToken,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !token.isCancellationRequested) {
      await fn(items[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Minimal glob matcher supporting **, *, ? and {a,b}. Paths use forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inBrace = false;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; inBrace = true; }
    else if (c === '}') { re += ')'; inBrace = false; }
    else if (c === ',' && inBrace) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function makeExcluder(exclude: string): (uri: vscode.Uri) => boolean {
  const re = globToRegExp(exclude);
  return (uri) => {
    if (!vscode.workspace.getWorkspaceFolder(uri)) return true; // library / SDK code
    return re.test(vscode.workspace.asRelativePath(uri, false));
  };
}

// ---------------------------------------------------------------------------
// Symbol index: answers "which graph symbol is at / encloses this position?"

class SymbolIndex {
  private byFile = new Map<string, Indexed[]>();
  readonly byId = new Map<string, Indexed>();

  add(sym: Indexed) {
    const key = sym.uriObj.toString();
    if (!this.byFile.has(key)) this.byFile.set(key, []);
    this.byFile.get(key)!.push(sym);
    this.byId.set(sym.id, sym);
  }

  remove(sym: Indexed) {
    this.byId.delete(sym.id);
    const list = this.byFile.get(sym.uriObj.toString());
    if (list) list.splice(list.indexOf(sym), 1);
  }

  /** Innermost symbol (optionally of the given kinds) whose body contains pos. */
  find(uri: vscode.Uri, pos: vscode.Position, kinds?: ReadonlySet<SymbolKindName>): Indexed | undefined {
    let best: Indexed | undefined;
    for (const s of this.byFile.get(uri.toString()) ?? []) {
      if (kinds && !kinds.has(s.kind)) continue;
      if (!s.fullRange.contains(pos)) continue;
      if (!best || best.fullRange.contains(s.fullRange)) best = s;
    }
    return best;
  }

  all(): Indexed[] {
    return [...this.byId.values()];
  }
}

class EdgeSet {
  private seen = new Set<string>();
  readonly list: GraphEdge[] = [];
  add(source: string, target: string, kind: EdgeKind) {
    if (source === target) return;
    const key = `${source}|${target}|${kind}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push({ source, target, kind });
  }
}

function publicSymbol(s: Indexed): GraphSymbol {
  const { id, name, kind, owner, file, uri, range, detail, root } = s;
  return { id, name, kind, owner, file, uri, range, detail, root };
}

// ---------------------------------------------------------------------------
// Expanding the explorer selection into a list of source files

export async function expandSelection(
  uris: vscode.Uri[],
  opts: BuildOptions,
): Promise<{ files: vscode.Uri[]; skipped: number }> {
  const found = new Map<string, vscode.Uri>();
  for (const uri of uris) {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      const inside = await vscode.workspace.findFiles(
        new vscode.RelativePattern(uri, '**/*'),
        opts.exclude,
      );
      for (const f of inside) {
        const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
        if (SOURCE_EXTENSIONS.has(ext)) found.set(f.toString(), f);
      }
    } else {
      found.set(uri.toString(), uri); // explicitly chosen files are always included
    }
  }
  const all = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files: all.slice(0, opts.maxFiles), skipped: Math.max(0, all.length - opts.maxFiles) };
}

// ---------------------------------------------------------------------------
// Graph for a set of files

const warmedUp = new Set<string>();

async function documentSymbols(doc: vscode.TextDocument) {
  type Sym = vscode.DocumentSymbol | vscode.SymbolInformation;
  // Language servers often answer with nothing until their project has loaded,
  // so retry until the first file of each language returns symbols.
  const attempts = warmedUp.has(doc.languageId) ? 1 : 4;
  for (let i = 0; i < attempts; i++) {
    const result = await exec<Sym[]>('vscode.executeDocumentSymbolProvider', doc.uri);
    if (result && result.length) {
      warmedUp.add(doc.languageId);
      return result;
    }
    if (i < attempts - 1) await delay(700 * (i + 1));
  }
  return [];
}

function mapKind(kind: vscode.SymbolKind, insideClass: boolean): SymbolKindName | 'container' | undefined {
  const K = vscode.SymbolKind;
  switch (kind) {
    case K.Class:
    case K.Struct:
      return 'class';
    case K.Interface:
      return 'interface';
    case K.Function:
      return insideClass ? 'method' : 'function';
    case K.Method:
    case K.Constructor:
      return 'method';
    case K.Variable:
    case K.Constant:
    case K.Field:
    case K.Property:
      return 'variable';
    case K.Namespace:
    case K.Module:
    case K.Package:
      return 'container';
    default:
      return undefined;
  }
}

/** Turns one file's document symbols into index entries. */
function collectSymbols(
  doc: vscode.TextDocument,
  symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  index: SymbolIndex,
): Indexed[] {
  const added: Indexed[] = [];
  const file = relPath(doc.uri);

  const addSymbol = (
    name: string,
    kind: SymbolKindName,
    fullRange: vscode.Range,
    nameRange: vscode.Range,
    owner?: Indexed,
    detail?: string,
  ) => {
    const sym: Indexed = {
      id: symbolId(doc.uri, name, nameRange.start),
      name,
      kind,
      owner: owner?.id,
      file,
      uri: doc.uri.toString(),
      range: toTuple(nameRange),
      detail: detail || undefined,
      uriObj: doc.uri,
      fullRange,
      namePos: nameRange.start,
    };
    if (index.byId.has(sym.id)) return undefined;
    index.add(sym);
    added.push(sym);
    return sym;
  };

  const walk = (list: vscode.DocumentSymbol[], owner: Indexed | undefined) => {
    for (const s of list) {
      const kind = mapKind(s.kind, owner?.kind === 'class');
      if (kind === 'container') {
        walk(s.children, owner);
      } else if (kind === 'class' || kind === 'interface') {
        const sym = addSymbol(s.name, kind, s.range, s.selectionRange, undefined, s.detail);
        if (sym) walk(s.children, sym);
      } else if (kind === 'function' || kind === 'method') {
        addSymbol(s.name, kind, s.range, s.selectionRange, owner, s.detail);
        // Local functions and variables inside a body are left out on purpose.
      } else if (kind === 'variable') {
        addSymbol(s.name, kind, s.range, s.selectionRange, owner, s.detail);
      }
    }
  };

  const first = symbols[0];
  if (first && 'selectionRange' in first) {
    walk(symbols as vscode.DocumentSymbol[], undefined);
  } else {
    // Flat SymbolInformation list: rebuild class membership from containerName.
    const classes = new Map<string, Indexed>();
    for (const s of symbols as vscode.SymbolInformation[]) {
      const owner = s.containerName ? classes.get(s.containerName) : undefined;
      const kind = mapKind(s.kind, !!owner);
      if (!kind || kind === 'container') continue;
      const sym = addSymbol(s.name, kind, s.location.range, s.location.range, TYPES.has(kind) ? undefined : owner);
      if (sym && TYPES.has(kind)) classes.set(s.name, sym);
    }
  }
  return added;
}

export async function buildFilesGraph(
  files: vscode.Uri[],
  opts: BuildOptions,
  progress: Progress,
  token: vscode.CancellationToken,
): Promise<GraphData> {
  const index = new SymbolIndex();
  const edges = new EdgeSet();
  const notes: string[] = [];
  const docs = new Map<string, vscode.TextDocument>();

  // 1. Symbols in every file
  let done = 0;
  await pool(files, 6, token, async (uri) => {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      docs.set(uri.toString(), doc);
      collectSymbols(doc, await documentSymbols(doc), index);
    } catch {
      notes.push(`Skipped ${relPath(uri)} (could not be opened as text).`);
    }
    progress.report({ message: `Reading symbols (${++done}/${files.length})`, increment: 30 / files.length });
  });

  // 2. Work out which variables are really functions (const f = () => {}),
  //    and prepare call hierarchy items for everything callable.
  const candidates = index.all().filter((s) => CALLABLE.has(s.kind) || (s.kind === 'variable' && !s.owner));
  done = 0;
  await pool(candidates, 8, token, async (s) => {
    const items = await exec<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', s.uriObj, s.namePos);
    const item = items?.[0];
    const isThisSymbol =
      !!item &&
      item.name.replace(/\(.*$/, '') === s.name.replace(/\(.*$/, '') &&
      item.selectionRange.contains(s.namePos);
    if (s.kind === 'variable' && isThisSymbol) s.kind = 'function';
    if (isThisSymbol || CALLABLE.has(s.kind)) s.callItem = item;
    progress.report({ message: `Preparing calls (${++done}/${candidates.length})`, increment: 20 / Math.max(1, candidates.length) });
  });

  if (!opts.withVariables) {
    for (const s of index.all()) if (s.kind === 'variable') index.remove(s);
  }

  // 3. Calls between symbols
  const callables = index.all().filter((s) => CALLABLE.has(s.kind) && s.callItem);
  done = 0;
  await pool(callables, 8, token, async (s) => {
    const calls = await exec<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', s.callItem);
    for (const call of calls ?? []) {
      const target = index.find(call.to.uri, call.to.selectionRange.start);
      if (target) edges.add(s.id, target.id, 'calls');
    }
    progress.report({ message: `Following calls (${++done}/${callables.length})`, increment: 30 / Math.max(1, callables.length) });
  });

  // 4. Inheritance
  const types = index.all().filter((s) => TYPES.has(s.kind));
  await pool(types, 6, token, async (s) => {
    for (const parent of await supertypesOf(s, docs.get(s.uri), index)) {
      const kind: EdgeKind = s.kind === 'class' && parent.kind === 'interface' ? 'implements' : 'extends';
      edges.add(s.id, parent.id, kind);
    }
  });
  progress.report({ message: 'Linking inheritance', increment: 10 });

  // 5. Variable references (who reads or writes each variable)
  if (opts.withVariables) {
    const vars = index.all().filter((s) => s.kind === 'variable');
    await pool(vars, 8, token, async (v) => {
      const refs = await exec<vscode.Location[]>('vscode.executeReferenceProvider', v.uriObj, v.namePos);
      for (const ref of refs ?? []) {
        const user = index.find(ref.uri, ref.range.start, CALLABLE);
        if (user) edges.add(user.id, v.id, 'references');
      }
    });
    progress.report({ message: 'Linking variables', increment: 10 });
  }

  const symbols = index.all();
  if (symbols.length === 0) {
    notes.push('No symbols were found. Check that a language extension is installed for these files.');
  }
  return {
    title: files.length === 1 ? relPath(files[0]) : `${files.length} files`,
    mode: 'files',
    symbols: symbols.map(publicSymbol),
    edges: edges.list,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Inheritance: type hierarchy provider first, text heuristic as a fallback

async function supertypesOf(s: Indexed, doc: vscode.TextDocument | undefined, index: SymbolIndex): Promise<Indexed[]> {
  const items = await exec<vscode.TypeHierarchyItem[]>('vscode.prepareTypeHierarchy', s.uriObj, s.namePos);
  if (items && items.length) {
    const supers = await exec<vscode.TypeHierarchyItem[]>('vscode.provideSupertypes', items[0]);
    return (supers ?? [])
      .map((t) => index.find(t.uri, t.selectionRange.start, TYPES))
      .filter((t): t is Indexed => !!t && t.id !== s.id);
  }
  if (!doc) return [];

  // No type hierarchy provider (e.g. TypeScript): read the declaration header,
  // pick out the base type names and resolve each with "go to definition".
  const found: Indexed[] = [];
  for (const pos of baseTypePositions(doc, s)) {
    const defs = await exec<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', doc.uri, pos);
    for (const d of defs ?? []) {
      const uri = 'targetUri' in d ? d.targetUri : d.uri;
      const range = 'targetUri' in d ? d.targetSelectionRange ?? d.targetRange : d.range;
      const t = index.find(uri, range.start, TYPES);
      if (t && t.id !== s.id) found.push(t);
    }
  }
  return found;
}

const MODIFIERS = new Set(['public', 'private', 'protected', 'virtual', 'internal', 'final', 'sealed', 'open', 'abstract']);

/** Positions of the base type names in a class/interface declaration header. */
export function baseTypePositions(doc: vscode.TextDocument, s: Indexed): vscode.Position[] {
  const startOffset = doc.offsetAt(new vscode.Position(s.range[2], s.range[3]));
  const header = doc.getText(new vscode.Range(doc.positionAt(startOffset), doc.positionAt(startOffset + 800)));
  return baseTypeOffsets(header, doc.languageId).map((o) => doc.positionAt(startOffset + o));
}

/** Pure text part of the heuristic, exported for testing. */
export function baseTypeOffsets(header: string, languageId: string): number[] {
  const tokens = [...header.matchAll(/([A-Za-z_$][\w$]*)|(\S)/g)].map((m) => ({
    id: !!m[1],
    v: m[0],
    at: m.index ?? 0,
  }));
  const out: number[] = [];

  if (languageId === 'python') {
    // class Foo(Base, mixins.Other, metaclass=Meta):
    if (tokens[0]?.v !== '(') return out;
    let depth = 0;
    let skippingKeywordValue = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.v === '(' || t.v === '[') depth++;
      else if (t.v === ')' || t.v === ']') { if (--depth === 0) break; }
      else if (depth === 1 && t.v === ',') skippingKeywordValue = false;
      else if (depth === 1 && t.id && !skippingKeywordValue) {
        const next = tokens[i + 1]?.v;
        if (next === '=') skippingKeywordValue = true;
        else if (next !== '.') out.push(t.at);
      }
    }
    return out;
  }

  // Brace languages: TypeScript, JavaScript, Java, C#, C++, Kotlin, Swift, Dart...
  let inBases = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < tokens.length && i < 120; i++) {
    const t = tokens[i];
    if (t.v === '{' || t.v === ';') break;
    if (t.v === '<') { angle++; continue; }
    if (t.v === '>') { angle = Math.max(0, angle - 1); continue; }
    if (t.v === '(') { paren++; continue; }
    if (t.v === ')') { paren = Math.max(0, paren - 1); continue; }
    if (angle > 0 || paren > 0) continue;
    if (t.v === 'where') break;
    if (t.v === 'extends' || t.v === 'implements' || t.v === ':' || t.v === 'with') {
      inBases = true;
      continue;
    }
    if (!inBases || !t.id || MODIFIERS.has(t.v)) continue;
    const next = tokens[i + 1]?.v;
    const isQualifier = next === '.' || (next === ':' && tokens[i + 2]?.v === ':');
    if (!isQualifier) out.push(t.at);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Call graph starting from one function (function graph and focus graph)

function kindFromItem(kind: vscode.SymbolKind): SymbolKindName {
  const K = vscode.SymbolKind;
  if (kind === K.Method || kind === K.Constructor) return 'method';
  if (kind === K.Class || kind === K.Struct) return 'class';
  if (kind === K.Interface) return 'interface';
  return 'function';
}

function symbolFromItem(item: vscode.CallHierarchyItem): Indexed {
  return {
    id: symbolId(item.uri, item.name, item.selectionRange.start),
    name: item.name,
    kind: kindFromItem(item.kind),
    file: relPath(item.uri),
    uri: item.uri.toString(),
    range: toTuple(item.selectionRange),
    detail: item.detail || undefined,
    uriObj: item.uri,
    fullRange: item.range,
    namePos: item.selectionRange.start,
    callItem: item,
  };
}

export async function rootItemAt(uri: vscode.Uri, pos: vscode.Position) {
  const items = await exec<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, pos);
  return items?.[0];
}

export function itemId(item: vscode.CallHierarchyItem): string {
  return symbolId(item.uri, item.name, item.selectionRange.start);
}

export async function buildCallGraph(
  root: vscode.CallHierarchyItem,
  opts: { outDepth: number; inDepth: number; exclude: string; maxNodes?: number },
  token?: vscode.CancellationToken,
): Promise<GraphData> {
  const excluded = makeExcluder(opts.exclude);
  const maxNodes = opts.maxNodes ?? 400;
  const nodes = new Map<string, Indexed>();
  const edges = new EdgeSet();
  const notes: string[] = [];

  const rootSym = symbolFromItem(root);
  rootSym.root = true;
  nodes.set(rootSym.id, rootSym);

  const walk = async (direction: 'out' | 'in', depth: number) => {
    let frontier = [rootSym];
    for (let level = 0; level < depth && frontier.length; level++) {
      const next: Indexed[] = [];
      for (const s of frontier) {
        if (token?.isCancellationRequested) return;
        const neighbours =
          direction === 'out'
            ? (await exec<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', s.callItem))?.map((c) => c.to)
            : (await exec<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', s.callItem))?.map((c) => c.from);
        for (const item of neighbours ?? []) {
          if (excluded(item.uri)) continue;
          const id = itemId(item);
          let sym = nodes.get(id);
          if (!sym) {
            if (nodes.size >= maxNodes) {
              if (!notes.length) notes.push(`Stopped at ${maxNodes} symbols. Lower the call depth to see a smaller graph.`);
              continue;
            }
            sym = symbolFromItem(item);
            nodes.set(id, sym);
            next.push(sym);
          }
          if (direction === 'out') edges.add(s.id, id, 'calls');
          else edges.add(id, s.id, 'calls');
        }
      }
      frontier = next;
    }
  };

  await walk('out', opts.outDepth);
  await walk('in', opts.inDepth);

  return {
    title: root.name,
    mode: opts.inDepth > 0 ? 'focus' : 'function',
    symbols: [...nodes.values()].map(publicSymbol),
    edges: edges.list,
    notes,
  };
}
