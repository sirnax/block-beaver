import ts from 'typescript';
import { extname, posix } from 'node:path';

const extensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const sourceKind = (name) => name.endsWith('.tsx') ? ts.ScriptKind.TSX : name.endsWith('.jsx') ? ts.ScriptKind.JSX : name.endsWith('.js') || name.endsWith('.mjs') || name.endsWith('.cjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
const evidence = (file, source, node) => {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { file, line: line + 1, column: character + 1, text: source.text.split(/\r?\n/)[line]?.trim().slice(0, 240) || '' };
};
function resolveImport(from, specifier, fileSet) {
  let base;
  if (specifier.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), specifier));
  else if (specifier.startsWith('@/')) base = `src/${specifier.slice(2)}`;
  else return null;
  for (const path of [base, ...[...extensions].map((e) => base + e), ...[...extensions].map((e) => `${base}/index${e}`)]) if (fileSet.has(path)) return path;
  return null;
}
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
function links(files, fileSet, addEdge) {
  for (const [path, file] of files) {
    if (file.plugin !== jsTsReactPlugin) continue;
    const { source, declarations } = file;
    const local = new Map(declarations.map((d) => [d.name, d.id]));
    const imported = new Map();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const target = resolveImport(path, statement.moduleSpecifier.text, fileSet);
      if (!target) continue;
      addEdge(`file:${path}`, `file:${target}`, ts.isImportDeclaration(statement) ? 'imports' : 'reexports', evidence(path, source, statement));
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
