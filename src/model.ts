/** Data model shared between the extension host and the webview. */

export type SymbolKindName = 'class' | 'interface' | 'function' | 'method' | 'variable';
export type EdgeKind = 'calls' | 'extends' | 'implements' | 'references';

export interface GraphSymbol {
  /** Stable id: file uri + name + position of the symbol's name. */
  id: string;
  name: string;
  kind: SymbolKindName;
  /** Id of the enclosing class, if this symbol is a member of a class in the graph. */
  owner?: string;
  /** Workspace-relative path of the file, used for grouping by file and folder. */
  file: string;
  uri: string;
  /** [startLine, startChar, endLine, endChar] of the symbol's name. */
  range: [number, number, number, number];
  /** Extra text shown in the status line, e.g. a signature. */
  detail?: string;
  /** Marks the symbol the graph was built from (function and focus graphs). */
  root?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface GraphData {
  title: string;
  mode: 'files' | 'function' | 'focus';
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  /** Human-readable notes, e.g. files skipped because of limits. */
  notes: string[];
}

export type ToWebview = { type: 'graph'; data: GraphData };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'reveal'; uri: string; range: [number, number, number, number] };
