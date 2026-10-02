// Compact, deterministic audit output for hooks and CI; the full JSON report stays the default.
const details = 'run block-beaver audit for the full report';
// reviewed-content findings carry only a status; give each one the step that clears it.
const statusFix = {
  'unreviewed-source': 'review it in a block slice (plan, check, review, approve) or record an exception with block-beaver exception',
  'unreviewed-manifest': 'review it in a block slice (plan, check, review, approve) or record an exception with block-beaver exception',
  'changed-after-review': 'the file changed after its review; re-run check and review for that slice',
  'missing-exception': 'record an exception: block-beaver exception ID --reason TEXT --paths PATH --check COMMAND',
};
const line = (parts) => parts.filter((part) => typeof part === 'string' && part).join(' · ');

export function formatAuditSummary(result) {
  const files = result.files?.length ?? 0;
  const warnings = [], seenWarnings = new Set();
  for (const rule of result.rules ?? []) for (const advisory of rule.advisories ?? []) {
    if (advisory.severity !== 'warning') continue;
    const key = `${advisory.code}\0${advisory.message}`;
    if (!seenWarnings.has(key)) { seenWarnings.add(key); warnings.push(advisory); }
  }
  if (result.pass) return `block-beaver audit: pass (${files} files, 0 errors${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'} - ${details}` : ''})\n`;
  const lines = [], seen = new Set();
  // One line per error: rule, path, field and message, then its fix on the same line.
  const add = (text, fix) => { if (seen.has(text)) return; seen.add(text); lines.push(`${text} - fix: ${fix || details}`); };
  for (const rule of result.rules ?? []) {
    if (rule.pass) continue;
    const findings = rule.findings ?? [];
    if (!findings.length) add(line([rule.id, rule.skipReason || 'failed']));
    for (const finding of findings) add(line([rule.id, finding.path, finding.field, finding.message]), finding.remediation || (rule.id === 'reviewed-content' ? statusFix[finding.message] : undefined));
  }
  for (const advisory of warnings) lines.push(line(['warning', advisory.code, advisory.path, advisory.message]));
  return `block-beaver audit: fail (${files} files, ${seen.size} error${seen.size === 1 ? '' : 's'})\n${lines.join('\n')}\n`;
}
