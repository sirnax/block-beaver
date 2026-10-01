import { parseFamiliesConfig } from './families/config.mjs';
import { validateBlock } from './contracts.mjs';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safePath = (path) => typeof path === 'string' && !!path && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && path.split('/').every((part) => part && part !== '.' && part !== '..');
const finding = (message, path, remediation) => ({ ...(path ? { path } : {}), message, ...(remediation ? { remediation } : {}) });
const rule = (id, findings = [], extra = {}) => {
  const unique = findings.filter((entry, index) => findings.findIndex((other) => other.path === entry.path && other.message === entry.message) === index);
  return { id, pass: unique.length === 0, findings: unique, ...extra };
};

const implementationSource = (node) => node.kind === 'file' && !node.generated && !node.familyRole;

export function auditCounts(graph) {
  const owned = new Set(graph.edges.filter((edge) => edge.kind === 'implemented-by').map((edge) => edge.to));
  return { coverage: graph.nodes.filter((node) => implementationSource(node) && !owned.has(node.id)).length, resolution: graph.resolutionReport?.length || 0 };
}

/** Pure gates over one selected source/config/manifest version. Never changes baselines. */
export function evaluateAuditRules({ graph, config, configPresent = config !== null, manifests = [], baseline = null, exceptions = [], paths = [], strict = false, installed = false, managedFindings = [], managedAdvisories = [], viewFindings = [], familyFindings = [], familyEnabled = false, priorBaseline = undefined, diagnostics = [] }) {
  familyFindings = [...familyFindings];
  const configFindings = [...diagnostics];
  if (configPresent) {
    if (!object(config)) configFindings.push(finding('Config must be an object.', '.blocks/config.json'));
    else {
      for (const diagnostic of parseFamiliesConfig(config).diagnostics) configFindings.push(finding(diagnostic.message, diagnostic.file));
      if (config.schemaVersion !== 1) configFindings.push(finding('Unsupported config schemaVersion.', '.blocks/config.json'));
      if (!Array.isArray(config.apps)) configFindings.push(finding('Config apps must be an array.', '.blocks/config.json'));
      if (config.enforcement?.agents !== undefined && !['guide', 'block'].includes(config.enforcement.agents)) configFindings.push(finding('enforcement.agents must be guide or block.', '.blocks/config.json'));
      if (config.ignore !== undefined && (!Array.isArray(config.ignore) || config.ignore.some((path) => typeof path !== 'string'))) configFindings.push(finding('ignore must be a list of patterns.', '.blocks/config.json'));
    }
    for (const entry of graph.diagnostics || []) configFindings.push(finding(`${entry.app || 'config'} ${entry.field}: ${entry.message}`, '.blocks/config.json'));
  }
  const manifestFindings = [];
  for (const diagnostic of graph.familyDiagnostics || []) {
    if (diagnostic.severity && diagnostic.severity !== 'error') continue;
    const target = diagnostic.rule === 'config-valid' ? configFindings : diagnostic.rule === 'family-drift' ? familyFindings : manifestFindings;
    target.push(finding(diagnostic.message, diagnostic.file, diagnostic.remediation));
  }
  const manifestNodes = manifests.filter((entry) => object(entry.value)).map(({ value, path }) => ({ id: `block:local:${value.id}`, kind: 'block', family: 'local', manifest: value, path }));
  const validationGraph = { ...graph, nodes: graph.nodes.filter((node) => node.kind !== 'block' || node.family !== 'local').concat(manifestNodes, paths.filter((path) => !graph.nodes.some((node) => node.id === `file:${path}`)).map((path) => ({ id: `file:${path}`, kind: 'file', path }))) };
  const seen = new Set();
  for (const entry of manifests) {
    if (entry.error) { manifestFindings.push(finding(entry.error, entry.path)); continue; }
    const manifest = entry.value;
    if (!object(manifest)) { manifestFindings.push(finding('Manifest must be an object.', entry.path)); continue; }
    if (manifest.schemaVersion !== 1) manifestFindings.push(finding('Unsupported manifest schemaVersion.', entry.path));
    if (entry.path !== `.blocks/manifests/${manifest.id}.json`) manifestFindings.push(finding('Manifest id must match its file name.', entry.path));
    if (seen.has(manifest.id)) manifestFindings.push(finding('Duplicate manifest id.', entry.path));
    seen.add(manifest.id);
    // Existing declarations validate without the proposal-only version increment requirement.
    const check = validateBlock(manifest, { ...validationGraph, nodes: validationGraph.nodes.filter((node) => node.manifest?.id !== manifest.id) });
    for (const error of check.errors) manifestFindings.push(finding(`${error.path}: ${error.message}`, entry.path));
  }
  const existingPaths = new Set(paths);
  const exceptionFindings = [];
  const allowances = [];
  for (const entry of exceptions) {
    const value = entry.value;
    if (entry.error || !object(value) || value.schemaVersion !== 1 || typeof value.reason !== 'string' || !value.reason.trim() || !Array.isArray(value.paths) || !value.paths.length) {
      exceptionFindings.push(finding(entry.error || 'Exception needs schemaVersion, reason and paths.', entry.path)); continue;
    }
    const named = value.paths.map((path) => typeof path === 'string' ? path : path?.path);
    if (named.some((path) => !safePath(path) || !existingPaths.has(path)) || new Set(named).size !== named.length) {
      exceptionFindings.push(finding('Exception paths must name existing distinct repository files.', entry.path)); continue;
    }
    if (value.type === 'ratchet') {
      if (value.paths.some((path) => typeof path !== 'string' || path.startsWith('.blocks/')) || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(value.id || '') || entry.path !== `.blocks/exceptions/${value.id}.json` || !['coverage-ratchet', 'resolution-ratchet'].includes(value.rule) || !Number.isInteger(value.allowance) || value.allowance < 1 || value.allowance > named.length) {
        exceptionFindings.push(finding('Ratchet exception needs a stable id, supported rule and bounded positive allowance.', entry.path)); continue;
      }
      allowances.push({ ...value, paths: named });
    } else if (value.type !== 'exception') exceptionFindings.push(finding('Unknown exception type.', entry.path));
  }
  const owners = new Map();
  for (const edge of graph.edges.filter((edge) => edge.kind === 'implemented-by')) {
    if (!owners.has(edge.to)) owners.set(edge.to, []);
    owners.get(edge.to).push(edge.from);
  }
  const blocks = new Map(graph.nodes.filter((node) => node.kind === 'block').map((node) => [node.id, node]));
  const linkFindings = [];
  for (const edge of graph.edges.filter((edge) => ['imports', 'reexports'].includes(edge.kind))) {
    for (const from of owners.get(edge.from) || []) for (const to of owners.get(edge.to) || []) {
      if (from !== to && !blocks.get(from)?.manifest?.dependencies?.includes(to) && !blocks.get(from)?.dependencies?.includes(to)) linkFindings.push(finding(`${from} imports ${to} without a declared dependency.`, edge.evidence?.file, `Declare ${to} in ${from}'s dependencies.`));
    }
  }
  const counts = auditCounts(graph);
  const ratchet = (id, key, enabled) => {
    if (!enabled) return rule(id, [], { skipped: true });
    if (!object(baseline) || baseline.schemaVersion !== 1 || !Number.isInteger(baseline[key]) || baseline[key] < 0) return rule(id, [finding(`Missing or invalid ${key} baseline.`, '.blocks/baseline.json', 'Run block-beaver install to initialize the baseline.')]);
    const relevant = key === 'coverage' ? graph.nodes.filter((node) => implementationSource(node) && !owners.has(node.id)).map((node) => node.path) : (graph.resolutionReport || []).map((report) => report.file);
    const scoped = new Set(relevant);
    const exempted = new Set();
    let allowance = 0;
    for (const entry of allowances.filter((entry) => entry.rule === id && entry.paths.every((path) => scoped.has(path)))) {
      const uniquePaths = entry.paths.filter((path) => !exempted.has(path));
      const used = uniquePaths.slice(0, entry.allowance);
      allowance += used.length;
      for (const path of used) exempted.add(path);
    }
    return rule(id, counts[key] > baseline[key] + allowance ? [finding(`${key} increased from ${baseline[key]} to ${counts[key]} (recorded allowance ${allowance}).`, '.blocks/baseline.json', 'Declare files in blocks, fix resolution, or record a scoped ratchet exception.')] : []);
  };
  const lintFindings = [];
  const lint = baseline?.lint?.['no-block-id-literal'];
  const oldLint = priorBaseline?.lint?.['no-block-id-literal'];
  const lintEnabled = lint !== undefined || oldLint !== undefined;
  if (lintEnabled) {
    if (lint !== undefined && !object(lint)) lintFindings.push(finding('Lint baseline must map repository file paths to nonnegative integer counts.', '.blocks/baseline.json'));
    else for (const [path, count] of Object.entries(lint || {})) {
      if (!safePath(path) || !existingPaths.has(path) || !Number.isSafeInteger(count) || count < 0) lintFindings.push(finding(`Invalid no-block-id-literal baseline entry: ${path}.`, '.blocks/baseline.json'));
      else if (object(priorBaseline) && count > (oldLint?.[path] ?? 0)) lintFindings.push(finding(`no-block-id-literal allowance for ${path} increased from ${oldLint?.[path] ?? 0} to ${count}.`, '.blocks/baseline.json', 'Lint allowances can only decrease.'));
    }
  }
  return [rule('managed-current', installed ? managedFindings : [], { skipped: !installed, advisories: managedAdvisories }), rule('config-valid', configFindings), rule('manifest-valid', manifestFindings), rule('view-fresh', installed ? viewFindings : [], { skipped: !installed }), rule('undeclared-link', linkFindings), ratchet('coverage-ratchet', 'coverage', installed || baseline !== null), ratchet('resolution-ratchet', 'resolution', strict && (installed || baseline !== null)), rule('exception-valid', exceptionFindings), rule('family-drift', familyFindings, { skipped: !familyEnabled && !familyFindings.length }), rule('lint-baseline-ratchet', lintFindings, { skipped: !lintEnabled })];
}
