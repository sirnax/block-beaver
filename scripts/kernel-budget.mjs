import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import ts from 'typescript';

// Aggregate compressed source, rather than a minified bundle, gives reproducible
// checks without requiring a particular bundler. Baseline is approximately 4.4 KiB.
export const KERNEL_GZIP_BUDGET = 6 * 1024;

export async function checkKernelBudget(directory = fileURLToPath(new URL('../src/kernel/', import.meta.url))) {
  const names = (await readdir(directory)).filter(name => name.endsWith('.mjs')).sort();
  const allowed = new Set(names.map(name => resolve(directory, name)));
  let gzipBytes = 0;
  for (const name of names) {
    const source = await readFile(resolve(directory, name), 'utf8');
    gzipBytes += gzipSync(source, { level: 9 }).length;
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function checkImport(specifier) {
      if (!specifier || !ts.isStringLiteral(specifier) || !/^\.\.?\//.test(specifier.text) || !allowed.has(resolve(directory, specifier.text))) {
        throw new Error(`Kernel import must stay inside the dependency-free kernel: ${name}: ${specifier?.getText(ast) ?? 'unknown'}`);
      }
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) checkImport(node.moduleSpecifier);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) checkImport(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  if (!names.length) throw new Error('Kernel runtime files are missing');
  if (gzipBytes > KERNEL_GZIP_BUDGET) throw new Error(`Kernel gzip budget exceeded: ${gzipBytes} > ${KERNEL_GZIP_BUDGET} bytes`);
  return { files: names, gzipBytes, budgetBytes: KERNEL_GZIP_BUDGET };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkKernelBudget();
  console.log(`Kernel gzip: ${result.gzipBytes}/${result.budgetBytes} bytes; relative imports only`);
}
