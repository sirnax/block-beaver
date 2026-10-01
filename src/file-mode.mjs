/** Windows chmod controls write permission only; execute bits are POSIX metadata. */
export function fileModeMatches(actual, expected) {
  const mask = process.platform === 'win32' ? 0o200 : 0o777;
  return (actual & mask) === (expected & mask);
}

/** Git tracks the owner execute bit on POSIX and retains index modes on Windows. */
export function gitModeForWorktreeFile(nativeMode, indexMode, platform = process.platform) {
  if (typeof nativeMode !== 'string' || !/^10[0-7]{4}$/.test(nativeMode)) throw new Error('Git file mode requires regular native file permissions.');
  if (platform !== 'win32') return (Number.parseInt(nativeMode, 8) & 0o100) ? '100755' : '100644';
  if (indexMode !== null && !['100644', '100755'].includes(indexMode)) throw new Error('Regular worktree file has a nonregular Git index entry.');
  return indexMode ?? '100644';
}
