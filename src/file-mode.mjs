/** Windows chmod controls write permission only; execute bits are POSIX metadata. */
export function fileModeMatches(actual, expected) {
  const mask = process.platform === 'win32' ? 0o200 : 0o777;
  return (actual & mask) === (expected & mask);
}

/** Windows stat permissions do not represent Git's retained executable bit. */
export function gitModeForWorktreeFile(nativeMode, indexMode, platform = process.platform) {
  if (platform !== 'win32') return nativeMode;
  if (indexMode !== null && !['100644', '100755'].includes(indexMode)) throw new Error('Regular worktree file has a nonregular Git index entry.');
  return indexMode ?? '100644';
}
