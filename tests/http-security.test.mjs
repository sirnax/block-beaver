import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalBrowserRequest, securityHeaders } from '../src/http-security.mjs';

test('local HTTP requests reject rebinding hosts and foreign origins', () => {
  assert.equal(isLocalBrowserRequest({ host: '127.0.0.1:4173' }), true);
  assert.equal(isLocalBrowserRequest({ host: 'localhost:4173', origin: 'http://localhost:4173' }), true);
  assert.equal(isLocalBrowserRequest({ host: 'attacker.example:4173' }), false);
  assert.equal(isLocalBrowserRequest({ host: 'localhost.attacker.example:4173' }), false);
  assert.equal(isLocalBrowserRequest({ host: 'localhost:4173', origin: 'https://attacker.example' }), false);
  assert.equal(isLocalBrowserRequest({ host: 'localhost:4173', origin: 'http://localhost:9999' }), false);
  assert.equal(isLocalBrowserRequest({ host: 'localhost:4173', origin: 'null' }), false);
  assert.match(securityHeaders['content-security-policy'], /frame-ancestors 'none'/);
});
