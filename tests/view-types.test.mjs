import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('view declarations type prepareView and its constants, and the export maps them', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.exports['./view'], { types: './src/view.d.ts', default: './src/view.mjs' });
  const file = fileURLToPath(new URL('../src/view-type-fixture.ts', import.meta.url)).replaceAll('\\', '/');
  const source = `
    import { prepareView, VIEW_NONCE_PLACEHOLDER, VIEW_HOST_HEADER_SLOT, type PrepareViewOptions } from 'block-beaver/view';
    const html: string = prepareView('<p/>', { nonce: 'abc', headerHtml: '<nav/>' });
    const bare: string = prepareView('<p/>');
    const options: PrepareViewOptions = {};
    const placeholder: '__BLOCK_BEAVER_NONCE__' = VIEW_NONCE_PLACEHOLDER;
    const slot: string = VIEW_HOST_HEADER_SLOT;
    // @ts-expect-error html must be a string
    prepareView(5);
    // @ts-expect-error the nonce is a string
    prepareView('', { nonce: 5 });
  `;
  const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host); const exists = host.fileExists.bind(host);
  host.readFile = (path) => path === file ? source : read(path);
  host.fileExists = (path) => path === file || exists(path);
  const errors = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  assert.deepEqual(errors.map((d) => `${d.file?.getLineAndCharacterOfPosition(d.start ?? 0).line}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`), []);
});
