/** Windows chmod controls write permission only; execute bits are POSIX metadata. */
export function fileModeMatches(actual, expected) {
  const mask = process.platform === 'win32' ? 0o200 : 0o777;
  return (actual & mask) === (expected & mask);
}
