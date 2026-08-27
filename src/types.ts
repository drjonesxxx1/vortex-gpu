export type OSName = 'windows11' | 'ubuntu24' | 'kali' | 'arch' | 'debian';
export type GpuSpec = 'RTX 4070 12GB' | 'RTX 4080 Super 16GB';
export type VMState = 'off' | 'booting' | 'running' | 'stopping' | 'suspended';

export interface VMStats {
  cpuLoad: number; // percentage 0-100
  gpuLoad: number; // percentage 0-100
  vramUsedGb: number; // e.g. 8.4
  vramTotalGb: number; // e.g. 16
  tempC: number; // e.g. 58
  pingMs: number; // e.g. 14
  fps: number; // e.g. 60
  networkUpMbps: number;
  networkDownMbps: number;
}

export interface VM {
  id: string;
  userId: string;
  name: string;
  os: OSName;
  gpuSpec: GpuSpec;
  vcpu: number;
  ramGb: number;
  storageGb: number;
  state: VMState;
  proxiflyIp: string;
  proxiflyLocation: string;
  proxiflyProtocol: 'SOCKS5' | 'HTTP';
  proxiflyType: 'Residential' | 'Datacenter' | 'Mobile';
  rdpPort: number;
  rdpUser: string;
  rdpPass: string;
  autoPowerOffMin: number;
  uptimeSeconds: number;
  installedAppTemplates: string[];
  stats: VMStats;
  createdTime: number;
}

export interface UserSession {
  id: string;
  username: string;
  isAdmin: boolean;
  balanceMinutes: number;
  btcAddress: string;
  activeVmId: string | null;
  createdAt: number;
}

export interface BtcPayInvoice {
  invoiceId: string;
  amountUsd: number;
  amountSats: number;
  btcAddress: string;
  lightningInvoice: string;
  status: 'pending' | 'settled' | 'expired';
  minutesAdded: number;
  createdAt: number;
  expiresAt: number;
}

export interface ProxiflyGlobalConfig {
  mode: 'random_residential' | 'datacenter_rotation' | 'strict_stealth';
  activePoolSize: number;
  autoRotateMinutes: number;
  blockMaliciousRanges: boolean;
  activeProxiesCount: number;
  avgLatencyMs: number;
}

export interface SystemNode {
  nodeId: string;
  hostname: string;
  region: string;
  gpuType: string;
  totalGpus: number;
  assignedVms: number;
  cpuUsagePct: number;
  memUsagePct: number;
  gpuUsagePct: number;
  status: 'online' | 'degraded' | 'maintenance';
}

export interface AppTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: 'AI & ML' | 'OS & Desktop' | 'Security & Tools' | 'Rendering';
  gpuRequirement: string;
}
