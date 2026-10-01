import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import { readProjectFile } from './project-files.mjs';

const execute = promisify(execFile);
const locks = { npm: ['package-lock.json', 'npm-shrinkwrap.json'], pnpm: ['pnpm-lock.yaml'], yarn: ['yarn.lock'], bun: ['bun.lock', 'bun.lockb'] };
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

/** Trusted local CLI prefixes for native agent/Git hooks and CI, including Yarn PnP. */
export function localBlockBeaverCommand(manager = 'npm') {
  const id = typeof manager === 'string' ? manager : manager?.id;
  const commands = { npm: 'npx --no-install block-beaver', pnpm: 'pnpm exec block-beaver', yarn: 'yarn exec block-beaver', bun: 'bunx --no-install block-beaver' };
  if (!Object.hasOwn(commands, id)) throw new Error('Local Block Beaver commands require npm, pnpm, yarn or bun.');
  return commands[id];
}

async function regularFile(path) {
  try { return (await stat(path)).isFile(); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false; throw error; }
}

/** Resolve standard Windows Node shims without starting cmd.exe or interpreting shell text. */
export async function resolvePackageExecutable(executable, { platform = process.platform, env = process.env, nodeExecutable = process.execPath, isFile = regularFile, read = (path) => readFile(path, 'utf8') } = {}) {
  if (platform !== 'win32') return { executable, args: [] };
  const manager = win32.basename(executable).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  if (!Object.hasOwn(locks, manager)) throw new Error(`Unsupported Windows package manager executable: ${executable}.`);
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const directories = pathValue.split(';').filter(Boolean).map((part) => part.replace(/^"|"$/g, ''));
  const candidates = /[\\/]/.test(executable) ? [executable] : directories.flatMap((directory) => ['.exe', '.cmd', '.bat'].map((ext) => win32.join(directory, `${manager}${ext}`)));
  for (const candidate of candidates) {
    if (!await isFile(candidate)) continue;
    if (/\.exe$/i.test(candidate)) return { executable: candidate, args: [] };
    const shim = await read(candidate);
    const allowed = new RegExp(`^node_modules[\\\\/](?:${manager}[\\\\/]bin[\\\\/](?:${manager}${manager === 'npm' ? '-cli' : ''})\\.(?:js|cjs|mjs)|corepack[\\\\/]dist[\\\\/]${manager}\\.js)$`, 'i');
    const scripts = [...shim.matchAll(/%(?:dp0%|~dp0)[\\/]([^"\r\n]*?\.(?:c?js|mjs))/gi)].map((match) => match[1]);
    for (const relative of scripts) {
      if (!allowed.test(relative)) continue;
      const script = win32.resolve(win32.dirname(candidate), relative);
      if (await isFile(script)) return { executable: nodeExecutable, args: [script] };
    }
    throw new Error(`Cannot safely execute Windows package manager shim ${candidate}. Install a standard ${manager} Node/Corepack shim or a native executable; shell wrappers are not executed.`);
  }
  throw new Error(`Package manager ${manager} was not found on Windows PATH. Install it or enable its Corepack shim.`);
}

async function defaultRunner(executable, args, options) {
  const resolved = await resolvePackageExecutable(executable);
  return execute(resolved.executable, [...resolved.args, ...args], options);
}

async function readPackage(root) {
  const text = await readProjectFile(root, 'package.json');
  if (text === null) throw new Error('Package installation requires a package.json in the repository root.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Cannot read package manager: package.json is invalid JSON.'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('package.json must contain an object.');
  return value;
}

/** Detect the host manager without executing it or changing any files. */
export async function detectPackageManager(root) {
  const pkg = await readPackage(root);
  const found = [];
  for (const [id, paths] of Object.entries(locks)) {
    for (const lockfile of paths) if (await readProjectFile(root, lockfile) !== null) found.push({ id, lockfile });
  }
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
  if (pkg.packageManager !== undefined && (typeof pkg.packageManager !== 'string' || !locks[declared])) throw new Error('Unsupported package.json packageManager; expected npm, pnpm, yarn or bun.');
  const ids = [...new Set(found.map((item) => item.id))];
  if (ids.length > 1 && (!declared || !ids.includes(declared))) throw new Error(`Conflicting package manager lockfiles: ${found.map((item) => item.lockfile).join(', ')}. Set package.json packageManager to the owning manager.`);
  if (ids.length === 1 && declared && declared !== ids[0]) throw new Error(`packageManager ${declared} conflicts with ${found[0].lockfile}.`);
  const id = declared || ids[0] || 'npm';
  const candidates = found.filter((item) => item.id === id);
  // npm gives shrinkwrap precedence; Bun prefers its current text lockfile.
  const lockfile = candidates.find((item) => item.lockfile === 'npm-shrinkwrap.json')?.lockfile || candidates[0]?.lockfile || null;
  const diagnostics = [];
  if (!lockfile) diagnostics.push(`No lockfile found; using ${id}${declared ? ' from package.json packageManager' : ' by default'}. Installation will create its lockfile.`);
  if (ids.length > 1) diagnostics.push(`Using owner-declared ${id}; other lockfiles are preserved: ${found.filter((item) => item.id !== id).map((item) => item.lockfile).join(', ')}.`);
  return { id, executable: id, lockfile, diagnostics };
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function lockMatches(root, manager, version) {
  if (!manager.lockfile || manager.lockfile === 'bun.lockb') return false;
  const text = await readProjectFile(root, manager.lockfile);
  if (text === null) return false;
  if (manager.id === 'npm') {
    try {
      const lock = JSON.parse(text);
      return lock.packages
        ? lock.packages['']?.devDependencies?.['block-beaver'] === version && lock.packages['node_modules/block-beaver']?.version === version
        : lock.dependencies?.['block-beaver']?.version === version;
    } catch { return false; }
  }
  const v = escapeRegex(version);
  if (manager.id === 'pnpm') {
    const importer = text.match(/^  \.:\s*\n([\s\S]*?)(?=^  \S|^\S|(?![\s\S]))/m)?.[1];
    return Boolean(importer && new RegExp(`^    devDependencies:\\s*\\n(?:(?!^    \\S)[\\s\\S])*?^      ['"]?block-beaver['"]?:\\s*\\n        specifier: ['"]?${v}['"]?\\s*\\n        version: ['"]?${v}(?:\\([^\\n]*\\))?['"]?\\s*$`, 'm').test(importer));
  }
  if (manager.id === 'yarn') {
    // Both classic and Berry stanzas name the requested exact version.
    return new RegExp(`^(?:"?block-beaver@(?:npm:)?${v}"?):\\s*\\n(?:(?!^\\S)[\\s\\S])*?^  version(?::)? ["']?${v}["']?\\s*$`, 'm').test(text);
  }
  if (manager.id === 'bun') {
    try {
      const lock = JSON.parse(text);
      return lock.workspaces?.['']?.devDependencies?.['block-beaver'] === version && lock.packages?.['block-beaver']?.[0] === `block-beaver@${version}`;
    } catch { return false; }
  }
  return false;
}

/** Pure plan: the package manager owns package.json and lockfile updates. */
export async function planPackageChange(root, { manager, version, operation = 'install' } = {}) {
  if (!['install', 'uninstall'].includes(operation)) throw new Error('Package operation must be install or uninstall.');
  if (operation === 'install' && (typeof version !== 'string' || !exactVersion.test(version))) throw new Error('Block Beaver must be pinned to an exact semantic version.');
  const detected = await detectPackageManager(root);
  const requested = typeof manager === 'string' ? manager : manager?.id;
  if (requested && requested !== detected.id) throw new Error(`Requested manager ${requested} differs from repository manager ${detected.id}.`);
  const pkg = await readPackage(root);
  const diagnostics = [...detected.diagnostics];
  const commands = [];
  const command = (args) => commands.push({ executable: detected.executable, args });
  const yarnBerry = /^yarn@(?:[2-9]|\d{2,})\./.test(pkg.packageManager || '') || /__metadata:/.test(await readProjectFile(root, 'yarn.lock') || '');
  const workspaceRoot = Boolean(pkg.workspaces) || await readProjectFile(root, 'pnpm-workspace.yaml') !== null;
  if (operation === 'uninstall') {
    if (pkg.devDependencies?.['block-beaver'] !== undefined || pkg.dependencies?.['block-beaver'] !== undefined) {
      command(detected.id === 'npm' ? ['uninstall', 'block-beaver', '--ignore-scripts'] : ['remove', 'block-beaver', ...(detected.id === 'yarn' ? [] : ['--ignore-scripts'])]);
    }
  } else if (pkg.devDependencies?.['block-beaver'] === version && !pkg.dependencies?.['block-beaver']) {
    if (!await lockMatches(root, detected, version)) {
      diagnostics.push(`The exact pin exists but ${detected.lockfile || 'the lockfile'} needs verification by ${detected.id}.`);
      command({ npm: ['install', '--package-lock-only', '--ignore-scripts'], pnpm: ['install', '--lockfile-only', '--ignore-scripts'], yarn: yarnBerry ? ['install', '--mode=update-lockfile'] : ['install', '--ignore-scripts'], bun: ['install', '--lockfile-only', '--ignore-scripts'] }[detected.id]);
    }
  } else {
    // Berry refuses moving a production dependency with --dev; remove it first.
    if (detected.id === 'yarn' && pkg.dependencies?.['block-beaver'] !== undefined) command(['remove', 'block-beaver']);
    command({ npm: ['install', '--save-dev', '--save-exact', '--ignore-scripts', `block-beaver@${version}`], pnpm: ['add', '--save-dev', '--save-exact', '--ignore-scripts', ...(workspaceRoot ? ['--workspace-root'] : []), `block-beaver@${version}`], yarn: ['add', '--dev', '--exact', ...(!yarnBerry ? ['--ignore-scripts', ...(workspaceRoot ? ['--ignore-workspace-root-check'] : [])] : []), `block-beaver@${version}`], bun: ['add', '--dev', '--exact', '--ignore-scripts', `block-beaver@${version}`] }[detected.id]);
  }
  const before = await readProjectFile(root, 'package.json');
  const next = structuredClone(pkg);
  if (operation === 'install') {
    next.devDependencies = { ...next.devDependencies, 'block-beaver': version };
    if (next.dependencies) delete next.dependencies['block-beaver'];
  } else {
    if (next.devDependencies) delete next.devDependencies['block-beaver'];
    if (next.dependencies) delete next.dependencies['block-beaver'];
  }
  const files = JSON.stringify(next) === JSON.stringify(pkg) ? [] : [{ path: 'package.json', before, content: `${JSON.stringify(next, null, 2)}\n`, commandOwned: true }];
  if (commands.length) diagnostics.push('Package-manager-owned package.json diffs are previews; lockfile changes are determined by the listed package manager command.');
  return { commands, files, diagnostics };
}

/** Runner seam uses executable + argument arrays, always with shell disabled. */
export async function runPackageChange(root, plan, { runner = defaultRunner, dryRun = false } = {}) {
  if (dryRun) return { commands: plan.commands, executions: [], diagnostics: plan.diagnostics, dryRun: true };
  const executions = [];
  for (const command of plan.commands) {
    const result = await runner(command.executable, [...command.args], { cwd: root, shell: false });
    const code = result?.exitCode ?? result?.code ?? result?.status;
    if (typeof code === 'number' && code !== 0) throw new Error(`Package manager ${command.executable} failed with exit code ${code}: ${result.stderr || ''}`);
    executions.push({ ...command, ...result });
  }
  return { commands: plan.commands, executions, diagnostics: plan.diagnostics, dryRun: false };
}
