// Compact, deterministic audit output for hooks and CI; the full JSON report stays the default.
const details = 'run block-beaver audit for the full report';
// reviewed-content findings carry only a status; give each one the step that clears it.
const statusFix = {
  'unreviewed-source': 'review it in a block slice (plan, check, review, approve) or record an exception with block-beaver exception',
  'unreviewed-manifest': 'review it in a block slice (plan, check, review, approve) or record an exception with block-beaver exception',
  'changed-after-review': 'the file changed after its review; re-run check and review for that slice',
  'missing-exception': 'record an exception: block-beaver exception ID --reason TEXT --paths PATH --check COMMAND',
};
// Paths and messages come from the project; control characters would break one-line-per-error or forge a status line in logs.
const clean = (text) => text.replace(/[\u0000-\u001f\u007f]/g, ' ');
const line = (parts) => clean(parts.filter((part) => typeof part === 'string' && part).join(' · '));

export function formatAuditSummary(result) {
  const count = result.files?.length ?? 0, files = `${count} file${count === 1 ? '' : 's'}`;
  const warnings = [], seenWarnings = new Set();
  for (const rule of result.rules ?? []) for (const advisory of rule.advisories ?? []) {
    if (advisory.severity !== 'warning') continue;
    const key = `${advisory.code}\0${advisory.message}`;
    if (!seenWarnings.has(key)) { seenWarnings.add(key); warnings.push(advisory); }
  }
  if (result.pass) return `block-beaver audit: pass (${files}, 0 errors${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'} - ${details}` : ''})\n`;
  const lines = [], seen = new Set();
  // One line per error: rule, path, field and message, then its fix on the same line.
  const add = (text, fix) => { if (seen.has(text)) return; seen.add(text); lines.push(`${text} - fix: ${clean(fix || details)}`); };
  for (const rule of result.rules ?? []) {
    if (rule.pass) continue;
    const findings = rule.findings ?? [];
    if (!findings.length) add(line([rule.id, rule.skipReason || 'failed']));
    for (const finding of findings) add(line([rule.id, finding.path, finding.field, finding.message]), finding.remediation || (rule.id === 'reviewed-content' ? statusFix[finding.message] : undefined));
  }
  for (const advisory of warnings) lines.push(line(['warning', advisory.code, advisory.path, advisory.message]));
  return `block-beaver audit: fail (${files}, ${seen.size} error${seen.size === 1 ? '' : 's'})\n${lines.join('\n')}\n`;
}

/** One line when `gen` is clean; one line per failing diagnostic otherwise. */
export function formatGenSummary(result) {
  const count = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  if (result.ok !== false && !result.diagnostics?.some((item) => item.severity === 'error')) {
    if (result.mode === 'check') return `block-beaver gen: ${count(result.outputs?.length ?? 0, 'output')} current\n`;
    if (result.mode === 'dry-run') return `block-beaver gen: would write ${count(result.pending?.length ?? 0, 'output')}\n`;
    return `block-beaver gen: wrote ${count(result.written?.length ?? 0, 'output')}\n`;
  }
  const lines = [], seen = new Set();
  for (const item of result.diagnostics ?? []) {
    if (item.severity !== 'error') continue;
    const text = line([item.file, item.region ? `region ${item.region}` : '', item.code, item.message]);
    if (!seen.has(text)) { seen.add(text); lines.push(text); }
  }
  if (!lines.length) lines.push('block-beaver gen: failed');
  return `${lines.join('\n')}\n`;
}
