/**
 * How a tenant reaches a KVM guest.
 *
 * These mirror what `POST /api/vms/provision` returns in its `access` object
 * (`{ protocol, host, port, username, password }`) and what `/api/me` then
 * persists on the vm row as `ip` / `port` / `username`. Windows guests get
 * `rdp`, Linux guests get `ssh`; there is no third protocol.
 *
 * The guide documents the command *form* by calling these with placeholder
 * arguments, and the machine card renders the real one by calling them with
 * the row's values — so the two can never describe different commands.
 */

/** The address you paste into an RDP client, or hand to any tool that wants a
 *  single `host:port` pair. */
export function hostPort(host: string, port: string | number): string {
  return `${host}:${port}`;
}

/** OpenSSH: the port is a flag, not part of the host. */
export function sshCommand(host: string, port: string | number, username: string): string {
  return `ssh ${username}@${host} -p ${port}`;
}

/** Windows Remote Desktop: `mstsc /v:` accepts `host:port` directly. */
export function rdpCommand(host: string, port: string | number): string {
  return `mstsc /v:${hostPort(host, port)}`;
}

/**
 * `ip` is NULL until provisioning finishes writing it, and `port` is allocated
 * up front but is still worth guarding. Returns null when there is nothing
 * truthful to show yet — callers render a waiting state instead of "null:null".
 */
export function vmEndpoint(
  os: string,
  ip: string | null | undefined,
  port: number | null | undefined,
  username: string | null | undefined,
): { protocol: 'RDP' | 'SSH'; address: string; command: string } | null {
  const host = (ip ?? '').trim();
  if (!host || port === null || port === undefined || !Number.isFinite(Number(port))) return null;
  const isWin = os === 'windows';
  return {
    protocol: isWin ? 'RDP' : 'SSH',
    address: hostPort(host, port),
    command: isWin ? rdpCommand(host, port) : sshCommand(host, port, (username ?? '').trim() || 'rent'),
  };
}
