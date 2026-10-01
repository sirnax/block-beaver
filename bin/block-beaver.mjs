#!/usr/bin/env node
// Keep agent hook startup independent of the compiler and workflow modules.
if (process.argv[2] === 'hook-check') await import('../src/hook-check-cli.mjs');
else await import('../src/cli.mjs');
