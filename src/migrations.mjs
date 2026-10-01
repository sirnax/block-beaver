/** Current persisted document schemas. Shipped migration steps are append-only. */
export const DOCUMENT_SCHEMA_VERSIONS = Object.freeze({
  config: 1,
  graph: 2,
  manifest: 1,
  roadmap: 1,
  history: 1,
  index: 1,
});

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Keep historical steps fixed once released. New schema versions add a new step.
const stampLegacyDocument = (value) => ({ ...value, schemaVersion: 1 });
const upgradeGraphToApps = (value) => ({
  ...value,
  schemaVersion: 2,
  apps: value.apps ?? [],
  nodes: (value.nodes ?? []).map((node) => ({ ...node, app: node.app ?? null, usedBy: node.usedBy ?? [] })),
});
const migrationSteps = Object.freeze(Object.fromEntries(Object.keys(DOCUMENT_SCHEMA_VERSIONS).map((kind) => [kind, Object.freeze({
  0: stampLegacyDocument,
  ...(kind === 'graph' ? { 1: upgradeGraphToApps } : {}),
})])));

function validateDocument(kind, value) {
  if (!object(value)) throw new Error(`${kind} document must be an object`);
  const version = Object.hasOwn(value, 'schemaVersion') ? value.schemaVersion : 0;
  if (!Number.isSafeInteger(version) || version < 0) throw new Error(`${kind} schemaVersion must be a nonnegative integer`);
  if (kind === 'graph') {
    if (value.nodes !== undefined && (!Array.isArray(value.nodes) || value.nodes.some((node) => !object(node)))) throw new Error('graph nodes must be an array of objects');
    if (value.apps !== undefined && !Array.isArray(value.apps)) throw new Error('graph apps must be an array');
    for (const node of value.nodes || []) if (node.usedBy !== undefined && !Array.isArray(node.usedBy)) throw new Error('graph node usedBy must be an array');
  }
  return version;
}

/**
 * Upgrade one persisted document through ordered pure N→N+1 steps.
 * No filesystem operations occur, and the input is never modified or retained.
 */
export function migrateDocument(kind, input, targetVersion = DOCUMENT_SCHEMA_VERSIONS[kind]) {
  if (!Object.hasOwn(DOCUMENT_SCHEMA_VERSIONS, kind)) throw new Error(`Unknown document kind: ${kind}`);
  const currentVersion = DOCUMENT_SCHEMA_VERSIONS[kind];
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) throw new Error(`${kind} target schemaVersion must be a nonnegative integer`);
  if (targetVersion > currentVersion) throw new Error(`Unsupported future ${kind} target schemaVersion ${targetVersion}; latest supported is ${currentVersion}`);
  // Family generation publishes a bare array, rather than a version envelope.
  // Its current format is schema 1; preserve that public JSON shape on upgrade.
  if (kind === 'index' && Array.isArray(input)) {
    if (targetVersion !== currentVersion) throw new Error(`Cannot downgrade index schemaVersion ${currentVersion} to ${targetVersion}`);
    return { value: structuredClone(input), applied: [] };
  }
  let version = validateDocument(kind, input);
  if (version > currentVersion) throw new Error(`Unsupported future ${kind} schemaVersion ${version}; latest supported is ${currentVersion}`);
  if (version > targetVersion) throw new Error(`Cannot downgrade ${kind} schemaVersion ${version} to ${targetVersion}`);
  // Validate the complete route before invoking any step.
  for (let from = version; from < targetVersion; from++) if (!migrationSteps[kind][from]) throw new Error(`Missing ${kind} migration ${from}→${from + 1}`);
  let value = structuredClone(input);
  const applied = [];
  while (version < targetVersion) {
    const from = version;
    value = migrationSteps[kind][from](value);
    version = validateDocument(kind, value);
    if (version !== from + 1) throw new Error(`Invalid ${kind} migration ${from}→${from + 1}`);
    applied.push({ kind, from, to: version });
  }
  return { value, applied };
}
