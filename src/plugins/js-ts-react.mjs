import ts from 'typescript';
import { extname } from 'node:path';

const extensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const sourceKind = (name) => name.endsWith('.tsx') ? ts.ScriptKind.TSX : name.endsWith('.jsx') ? ts.ScriptKind.JSX : name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
const sourceLines = new WeakMap();
const evidence = (file, source, node) => {
  if (!sourceLines.has(source)) sourceLines.set(source, source.text.split(/\r?\n/));
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: line + 1, column: character + 1, text: sourceLines.get(source)[line]?.trim().slice(0, 240) || '' };
};
function symbolKind(name, node, source) {
  if (ts.isClassDeclaration(node)) return 'class';
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (/^[A-Z]/.test(name) && (source.fileName.endsWith('x') || /<\w/.test(node.getText(source)))) return 'component';
  return 'function';
}
function declarations(source, path) {
  const found = [];
  for (const statement of source.statements) {
    const exported = !!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) found.push({ name: statement.name.text, node: statement, exported });
    else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer) ||
            (ts.isCallExpression(declaration.initializer) && ['memo', 'forwardRef'].includes(declaration.initializer.expression.getText(source).split('.').pop())))) {
          found.push({ name: declaration.name.text, node: declaration, exported });
        }
      }
    }
  }
  return found.map((d) => ({ ...d, id: `symbol:${path}#${d.name}`, kind: symbolKind(d.name, d.node, source) }));
}
function links(files, fileSet, addEdge, context = {}) {
  for (const [path, file] of files) {
    if (file.plugin !== jsTsReactPlugin || context.shouldLink?.(path) === false) continue;
    const { source, declarations } = file;
    const local = new Map(declarations.map((d) => [d.name, d.id]));
    const imported = new Map();
    const imports = [];
    function collect(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        imports.push({ node, specifier: node.moduleSpecifier.text, kind: ts.isImportDeclaration(node) ? 'imports' : 'reexports' });
      } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        imports.push({ node, specifier: node.arguments[0].text, kind: 'imports', mode: node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'import' : 'require' });
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
        imports.push({ node, specifier: node.moduleReference.expression.text, kind: 'imports', mode: 'require' });
      }
      ts.forEachChild(node, collect);
    }
    collect(source);
    for (const { node: statement, specifier, kind, mode } of imports) {
      const resolution = context.resolveImport?.(path, specifier, { mode });
      const target = resolution?.path;
      const proof = evidence(path, source, statement);
      if (!target || !fileSet.has(target)) {
        if (!resolution?.external) context.reportUnresolved?.(path, specifier, proof, resolution?.error || (target ? `Resolved file is outside scanned source: ${target}` : `Cannot resolve module '${specifier}'`), resolution?.category);
        continue;
      }
      addEdge(`file:${path}`, `file:${target}`, kind, proof);
      if (!ts.isImportDeclaration(statement) || !statement.importClause || statement.importClause.isTypeOnly) continue;
      const clause = statement.importClause;
      if (clause.name) {
        const targetFile = files.get(target);
        const defaultDeclaration = targetFile?.declarations.find((d) => d.node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword));
        const defaultAssignment = targetFile?.source.statements.find((s) => ts.isExportAssignment(s) && ts.isIdentifier(s.expression));
        const defaultName = defaultDeclaration?.name || defaultAssignment?.expression.text;
        if (defaultName) imported.set(clause.name.text, `symbol:${target}#${defaultName}`);
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) imported.set(element.name.text, `symbol:${target}#${element.propertyName?.text || element.name.text}`);
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) imported.set(clause.namedBindings.name.text, `namespace:${target}`);
    }
    for (const declaration of declarations) {
      function visit(node) {
        let name = null;
        let kind = null;
        if (ts.isCallExpression(node)) {
          if (ts.isIdentifier(node.expression)) name = node.expression.text;
          else if (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)) name = `${node.expression.expression.text}.${node.expression.name.text}`;
          kind = 'calls';
        } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          if (ts.isIdentifier(node.tagName)) name = node.tagName.text;
          kind = 'renders';
        }
        if (name) {
          let target = local.get(name) || imported.get(name);
          if (!target && name.includes('.')) {
            const [namespace, member] = name.split('.');
            const base = imported.get(namespace);
            if (base?.startsWith('namespace:')) target = `symbol:${base.slice(10)}#${member}`;
          }
          if (target && target !== declaration.id) addEdge(declaration.id, target, kind, evidence(path, source, node));
        }
        ts.forEachChild(node, visit);
      }
      ts.forEachChild(declaration.node, visit);
    }
  }
}

export const jsTsReactPlugin = {
  id: 'js-ts-react',
  accepts: (path) => extensions.has(extname(path)) && !path.endsWith('.d.ts'),
  parse: (path, text) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, sourceKind(path)),
  declarations,
  evidence,
  links,
};
