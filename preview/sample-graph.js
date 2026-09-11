// Sample data for previewing the webview in a normal browser (npm run preview).
window.SAMPLE_GRAPH = (function () {
  const symbols = [];
  const edges = [];
  const add = (file, name, kind, line, owner) => {
    const id = `file:///app/${file}#${name}@${line}:4`;
    symbols.push({ id, name, kind, owner, file, uri: `file:///app/${file}`, range: [line, 4, line, 4 + name.length] });
    return id;
  };
  const link = (source, target, kind = 'calls') => edges.push({ source, target, kind });

  const INode = add('src/parser/ast.ts', 'AstNode', 'interface', 2);
  const Expr = add('src/parser/ast.ts', 'Expression', 'class', 10);
  const Binary = add('src/parser/ast.ts', 'BinaryExpression', 'class', 24);
  const Literal = add('src/parser/ast.ts', 'Literal', 'class', 40);
  const exprEval = add('src/parser/ast.ts', 'evaluate', 'method', 14, Expr);
  const binEval = add('src/parser/ast.ts', 'evaluate', 'method', 30, Binary);
  const litEval = add('src/parser/ast.ts', 'evaluate', 'method', 44, Literal);

  const Lexer = add('src/parser/lexer.ts', 'Lexer', 'class', 5);
  const next = add('src/parser/lexer.ts', 'nextToken', 'method', 12, Lexer);
  const peek = add('src/parser/lexer.ts', 'peek', 'method', 30, Lexer);
  const skipWs = add('src/parser/lexer.ts', 'skipWhitespace', 'method', 41, Lexer);
  const readNum = add('src/parser/lexer.ts', 'readNumber', 'method', 52, Lexer);

  const Parser = add('src/parser/parser.ts', 'Parser', 'class', 8);
  const parse = add('src/parser/parser.ts', 'parse', 'method', 15, Parser);
  const parseExpr = add('src/parser/parser.ts', 'parseExpression', 'method', 22, Parser);
  const parseTerm = add('src/parser/parser.ts', 'parseTerm', 'method', 40, Parser);
  const parsePrimary = add('src/parser/parser.ts', 'parsePrimary', 'method', 58, Parser);
  const expect = add('src/parser/parser.ts', 'expect', 'method', 75, Parser);

  const log = add('src/utils/log.ts', 'log', 'function', 3);
  const warn = add('src/utils/log.ts', 'warn', 'function', 9);
  const level = add('src/utils/log.ts', 'LOG_LEVEL', 'variable', 1);
  const fmt = add('src/utils/format.ts', 'formatError', 'function', 4);

  const main = add('src/cli.ts', 'main', 'function', 6);
  const readInput = add('src/cli.ts', 'readInput', 'function', 20);
  const run = add('src/cli.ts', 'run', 'function', 31);

  link(Expr, INode, 'implements');
  link(Binary, Expr, 'extends');
  link(Literal, Expr, 'extends');
  link(binEval, exprEval);
  link(next, skipWs); link(next, readNum); link(next, peek); link(readNum, peek);
  link(parse, parseExpr); link(parseExpr, parseTerm); link(parseTerm, parsePrimary);
  link(parsePrimary, parseExpr); link(parsePrimary, expect); link(expect, next);
  link(parsePrimary, next); link(parseTerm, next); link(parseExpr, Binary); link(parsePrimary, Literal);
  link(expect, fmt); link(fmt, warn); link(warn, log);
  link(log, level, 'references'); link(warn, level, 'references'); link(main, level, 'references');
  link(main, readInput); link(main, run); link(run, Lexer); link(run, Parser); link(run, parse);
  link(run, exprEval); link(run, log); link(readInput, warn); link(litEval, log);

  return { title: 'src', mode: 'files', symbols, edges, notes: [] };
})();
