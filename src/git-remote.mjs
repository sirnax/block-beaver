// Provider detection is based on the remote host, never a substring of its path.
export function remoteProvider(origin) {
  let hostname;
  if (origin.includes('://')) {
    try {
      const remote = new URL(origin);
      if (!['https:', 'http:', 'ssh:', 'git:', 'git+ssh:'].includes(remote.protocol)) return null;
      hostname = remote.hostname;
    } catch { return null; }
  } else {
    const scp = /^(?:[^@\s/:]+@)?([^\s/:@]+):[^\s]+$/.exec(origin);
    if (!scp) return null;
    hostname = scp[1];
  }
  hostname = hostname.toLowerCase();
  return hostname === 'github.com' ? 'github' : hostname === 'gitlab.com' ? 'gitlab' : null;
}
