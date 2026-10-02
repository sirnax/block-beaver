import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAuditSummary } from '../src/audit-format.mjs';

const files = (count) => Array.from({ length: count }, (_, index) => ({ path: `src/f${index}.mjs` }));
const info = (path) => ({ code: 'unreviewed-source', severity: 'info', path, message: 'unreviewed' });
const warning = (message = 'Host config is unsupported.') => ({ code: 'unsupported-host-config', severity: 'warning', message, remediation: 'Upgrade the host.' });

test('a passing audit prints exactly one line and hides info advisories', () => {
  const text = formatAuditSummary({ pass: true, files: files(8), rules: [{ id: 'reviewed-content', pass: true, findings: [], advisories: files(8).map((file) => info(file.path)) }] });
  assert.equal(text, 'block-beaver audit: pass (8 files, 0 errors)\n');
  assert.equal(formatAuditSummary({ pass: true, files: [], rules: [] }), 'block-beaver audit: pass (0 files, 0 errors)\n');
});

test('a passing audit with warnings is still one line and counts each distinct warning once', () => {
  const rules = [{ id: 'a', pass: true, findings: [], advisories: [warning(), info('x')] }, { id: 'b', pass: true, findings: [], advisories: [warning(), warning('Another.')] }];
  const text = formatAuditSummary({ pass: true, files: files(3), rules });
  assert.equal(text.trimEnd().split('\n').length, 1);
  assert.match(text, /^block-beaver audit: pass \(3 files, 0 errors, 2 warnings - run block-beaver audit for the full report\)\n$/);
  assert.match(formatAuditSummary({ pass: true, files: files(1), rules: [rules[0]] }), /, 1 warning - /);
});

test('a failing audit prints each error once with its rule id and remediation', () => {
  const finding = { path: 'src/a.mjs', field: 'owner', message: 'No owner.', remediation: 'Declare an owner.' };
  const rules = [
    { id: 'owned-source', pass: false, findings: [finding, { ...finding }, { path: 'src/b.mjs', message: 'No owner.', remediation: 'Declare an owner.' }, { message: 'Global problem.' }] },
    { id: 'passing', pass: true, findings: [{ message: 'ignored' }] },
    { id: 'config-valid', pass: false, findings: [{ ...finding }], advisories: [warning(), warning()] },
  ];
  const lines = formatAuditSummary({ pass: false, files: files(2), rules }).trimEnd().split('\n');
  assert.deepEqual(lines, [
    'block-beaver audit: fail (2 files, 4 errors)',
    'owned-source · src/a.mjs · owner · No owner. - fix: Declare an owner.',
    'owned-source · src/b.mjs · No owner. - fix: Declare an owner.',
    'owned-source · Global problem. - fix: run block-beaver audit for the full report',
    'config-valid · src/a.mjs · owner · No owner. - fix: Declare an owner.',
    'warning · unsupported-host-config · Host config is unsupported.',
  ]);
});

test('a failing audit with one error uses the singular header and hides info advisories', () => {
  const text = formatAuditSummary({ pass: false, files: files(1), rules: [{ id: 'reviewed-content', pass: false, findings: [{ path: 'src/a.mjs', message: 'unreviewed-source' }], advisories: [info('src/a.mjs')] }] });
  assert.equal(text, 'block-beaver audit: fail (1 file, 1 error)\nreviewed-content · src/a.mjs · unreviewed-source - fix: review it in a block slice (plan, check, review, approve) or record an exception with block-beaver exception\n');
});

test('a failing rule without findings still prints one line naming the rule', () => {
  const text = formatAuditSummary({ pass: false, files: files(1), rules: [{ id: 'view-fresh', pass: false, findings: [] }, { id: 'reviewed-content', pass: false, findings: [{ path: 'docs/a.md', message: 'missing-exception' }] }] });
  assert.deepEqual(text.trimEnd().split('\n'), [
    'block-beaver audit: fail (1 file, 2 errors)',
    'view-fresh · failed - fix: run block-beaver audit for the full report',
    'reviewed-content · docs/a.md · missing-exception - fix: record an exception: block-beaver exception ID --reason TEXT --paths PATH --check COMMAND',
  ]);
});

test('control characters in paths, messages and fixes cannot add lines or forge a status line', () => {
  const hostile = { path: 'src/a\nblock-beaver audit: pass (0 files, 0 errors)\u001b[2K.mjs', message: 'bad\r\nblock-beaver audit: pass (9 files, 0 errors)\u007f', remediation: 'fix\u0000it\nnow' };
  const text = formatAuditSummary({ pass: false, files: files(1), rules: [{ id: 'r', pass: false, findings: [hostile], advisories: [{ ...warning('w\nblock-beaver audit: pass') , path: 'p\u001b[31m' }] }] });
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('block-beaver audit: fail (1 file, 1 error)'));
  assert.ok(lines.slice(1).every((entry) => !entry.startsWith('block-beaver audit: pass')));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text));
});
