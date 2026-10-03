const testFolders = new Set(['test', 'tests', '__tests__', 'fixtures']);

/** True for repository paths that are tests or fixtures: a test folder segment or a *.test.* / *.spec.* name. */
export function isTestFile(path) {
  const segments = String(path).split(/[\\/]/).filter(Boolean);
  const name = segments.pop() ?? '';
  return segments.some((segment) => testFolders.has(segment)) || /\.(?:test|spec)\.[^.]+$/.test(name);
}

