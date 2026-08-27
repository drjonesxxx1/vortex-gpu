import { AppTemplate, SystemNode, ProxiflyGlobalConfig } from '../types';

export const AI_APP_TEMPLATES: AppTemplate[] = [
  {
    id: 'comfyui',
    name: 'ComfyUI + SDXL & Flux',
    icon: 'Sparkles',
    description: 'Node-based GUI for Stable Diffusion, Flux.1, and AnimateDiff with full TensorRT CUDA acceleration.',
    category: 'AI & ML',
    gpuRequirement: 'RTX 4070 / 4080 (12GB+ VRAM)',
  },
  {
    id: 'automatic1111',
    name: 'Automatic1111 WebUI',
    icon: 'Image',
    description: 'Classic Stable Diffusion WebUI with ControlNet, LoRAs, and xFormers optimization.',
    category: 'AI & ML',
    gpuRequirement: 'RTX 4070 12GB',
  },
  {
    id: 'ollama-webui',
    name: 'Ollama + Open-WebUI (LLMs)',
    icon: 'MessageSquareText',
    description: 'Run DeepSeek-R1 14B/32B, Llama 3.3 70B quantized, and Qwen local LLMs fully in VRAM.',
    category: 'AI & ML',
    gpuRequirement: 'RTX 4080 Super (16GB VRAM)',
  },
  {
    id: 'fooocus',
    name: 'Fooocus AI Studio',
    icon: 'Wand2',
    description: 'Midjourney-style prompt interface for instant photo-realistic image creation.',
    category: 'AI & ML',
    gpuRequirement: 'RTX 4070 12GB',
  },
  {
    id: 'blender-gpu',
    name: 'Blender 4.3 Cycles OptiX',
    icon: 'Box',
    description: '3D rendering workspace with hardware OptiX raytracing and AI denoising.',
    category: 'Rendering',
    gpuRequirement: 'RTX 4070 / 4080',
  },
  {
    id: 'kali-sec-tools',
    name: 'CyberSec Research Suite',
    icon: 'Shield',
    description: 'Isolated sandbox environment with Wireshark, Hashcat GPU acceleration, and network analysis tools.',
    category: 'Security & Tools',
    gpuRequirement: 'RTX 4070 12GB',
  },
];

export const INITIAL_NODES: SystemNode[] = [
  {
    nodeId: 'node-us-east-1a',
    hostname: 'vortex-gpu-node-01.local',
    region: 'US-East (Local Host Host rig)',
    gpuType: 'NVIDIA GeForce RTX 4080 Super 16GB',
    totalGpus: 4,
    assignedVms: 3,
    cpuUsagePct: 42,
    memUsagePct: 58,
    gpuUsagePct: 71,
    status: 'online',
  },
  {
    nodeId: 'node-us-west-1b',
    hostname: 'vortex-gpu-node-02.local',
    region: 'US-West (Rig 02)',
    gpuType: 'NVIDIA GeForce RTX 4070 12GB',
    totalGpus: 8,
    assignedVms: 5,
    cpuUsagePct: 35,
    memUsagePct: 49,
    gpuUsagePct: 62,
    status: 'online',
  },
  {
    nodeId: 'node-eu-central-1',
    hostname: 'vortex-gpu-node-03.local',
    region: 'EU-Central Cluster',
    gpuType: 'NVIDIA GeForce RTX 4080 Super 16GB',
    totalGpus: 6,
    assignedVms: 4,
    cpuUsagePct: 28,
    memUsagePct: 41,
    gpuUsagePct: 54,
    status: 'online',
  },
];

export const INITIAL_PROXIFLY_CONFIG: ProxiflyGlobalConfig = {
  mode: 'random_residential',
  activePoolSize: 12480,
  autoRotateMinutes: 30,
  blockMaliciousRanges: true,
  activeProxiesCount: 48,
  avgLatencyMs: 28,
};

export const PROXIFLY_IP_POOL = [
  { ip: '185.220.101.42', loc: 'Frankfurt, DE', type: 'Residential', proto: 'SOCKS5' },
  { ip: '104.28.192.11', loc: 'Zurich, CH', type: 'Residential', proto: 'SOCKS5' },
  { ip: '198.51.100.89', loc: 'Tokyo, JP', type: 'Residential', proto: 'HTTP' },
  { ip: '192.0.2.144', loc: 'Amsterdam, NL', type: 'Residential', proto: 'SOCKS5' },
  { ip: '198.18.23.110', loc: 'Singapore, SG', type: 'Datacenter', proto: 'SOCKS5' },
  { ip: '203.0.113.77', loc: 'Reykjavik, IS', type: 'Residential', proto: 'SOCKS5' },
  { ip: '185.107.56.201', loc: 'Stockholm, SE', type: 'Residential', proto: 'SOCKS5' },
  { ip: '91.200.12.33', loc: 'London, UK', type: 'Datacenter', proto: 'HTTP' },
];
