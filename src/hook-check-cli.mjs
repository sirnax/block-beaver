import { resolve } from 'node:path';
import { hookCheck, formatHookOutput } from './hook-check.mjs';

// The complete process budget includes module startup and input, not just cache reads.
const remaining = () => Math.max(0, 500 - process.uptime() * 1000);
const args = process.argv.slice(3);
const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1] ?? fallback; };
try {
  const input = await new Promise((done) => {
    let text = '', size = 0, finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.pause();
      done(value);
    };
    const timer = setTimeout(() => finish(null), Math.min(100, remaining()));
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > 1_000_000) finish(null);
      else text += chunk;
    });
    process.stdin.on('end', () => { try { finish(JSON.parse(text)); } catch { finish(null); } });
    process.stdin.on('error', () => finish(null));
  });
  if (input && remaining() > 0) {
    const result = await hookCheck(input, { root: resolve(option('root', process.cwd())), deadlineMs: remaining() });
    const output = formatHookOutput(result, { agent: option('agent', 'claude') });
    if (output && remaining() > 0) process.stdout.write(JSON.stringify(output) + '\n');
  }
} catch { /* Agent context must fail open, including malformed flags and cache state. */ }
// Flush stdout before the forced exit so a piped hook response is not truncated.
process.exitCode = 0;
process.stdout.write('', () => process.exit(0));
