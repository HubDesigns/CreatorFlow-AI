const os = require('os');
const { execFile: nodeExecFile } = require('child_process');

function execFileText(execFile, command, args, timeout = 1800) {
  return new Promise(resolve => {
    execFile(command, args, { windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? '' : String(stdout || '').trim());
    });
  });
}

function parseNvidiaSmi(output = '') {
  return String(output).split(/\r?\n/).map(line => {
    const match = line.trim().match(/^(.+?),\s*(\d+)\s*$/);
    if (!match) return null;
    return {
      name: match[1].trim(),
      dedicatedMemoryMb: Number(match[2]),
      vendor: 'NVIDIA',
      source: 'nvidia-smi'
    };
  }).filter(Boolean);
}

function parseWindowsAdapters(output = '') {
  return String(output).split(/\r?\n/).map(line => {
    const parts = line.split('|');
    if (parts.length < 2 || !parts[0].trim()) return null;
    const name = parts[0].trim();
    const bytes = Number(parts[1]);
    const vendor = /nvidia/i.test(name) ? 'NVIDIA' : /intel/i.test(name) ? 'Intel' : /amd|radeon/i.test(name) ? 'AMD' : 'Unknown';
    return {
      name,
      dedicatedMemoryMb: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1024 / 1024) : null,
      vendor,
      source: 'windows-device-manager'
    };
  }).filter(Boolean);
}

function classifyHardware({ totalMemoryMb, gpus }) {
  const discrete = gpus.filter(gpu => gpu.vendor !== 'Intel');
  const nvidia = discrete.find(gpu => gpu.vendor === 'NVIDIA' && gpu.dedicatedMemoryMb);
  const bestDiscrete = discrete
    .filter(gpu => Number(gpu.dedicatedMemoryMb) > 0)
    .sort((a, b) => b.dedicatedMemoryMb - a.dedicatedMemoryMb)[0];
  const vram = Number(bestDiscrete?.dedicatedMemoryMb || 0);
  const ramGb = totalMemoryMb / 1024;
  let profile = 'integrated';
  if (vram >= 8 && ramGb >= 16) profile = 'high_gpu';
  else if (vram >= 4 && ramGb >= 12) profile = 'entry_gpu';
  else if (ramGb >= 16) profile = 'integrated_plus';
  return {
    profile,
    ramGb: Math.round(ramGb * 10) / 10,
    dedicatedVramGb: vram ? Math.round((vram / 1024) * 10) / 10 : null,
    localLtxCandidate: Boolean(nvidia && nvidia.dedicatedMemoryMb >= 8192 && ramGb >= 16),
    defaultVideoMode: 'footage_first',
    explanation: profile === 'high_gpu'
      ? 'A dedicated GPU with at least 8 GB reported VRAM was detected. Local AI video may be tested as an optional engine; compatibility is not guaranteed.'
      : profile === 'entry_gpu'
        ? 'A lower-tier dedicated GPU was detected. Use footage-first rendering; avoid assuming large local video models will fit.'
        : 'No suitable dedicated GPU was confirmed. Use footage-first rendering with FFmpeg; integrated graphics and CPU-only systems remain supported.'
  };
}

async function detectHardwareProfile(options = {}) {
  const platform = options.platform || process.platform;
  const cpus = options.cpus || os.cpus();
  const totalMemoryMb = Math.round((options.totalmem || os.totalmem)() / 1024 / 1024);
  const execFile = options.execFile || nodeExecFile;
  let gpus = [];

  const nvidiaOutput = await execFileText(
    execFile,
    'nvidia-smi',
    ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
    options.timeoutMs || 1800
  );
  gpus = parseNvidiaSmi(nvidiaOutput);

  if (!gpus.length && platform === 'win32') {
    const script = 'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }';
    const windowsOutput = await execFileText(
      execFile,
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      options.timeoutMs || 1800
    );
    gpus = parseWindowsAdapters(windowsOutput);
  }

  const summary = classifyHardware({ totalMemoryMb, gpus });
  return {
    platform,
    architecture: options.arch || process.arch,
    cpu: {
      model: cpus[0]?.model || 'Unknown CPU',
      logicalCores: cpus.length
    },
    memory: {
      totalMb: totalMemoryMb,
      totalGb: summary.ramGb
    },
    gpus,
    ...summary,
    detectedAt: new Date().toISOString()
  };
}

module.exports = {
  detectHardwareProfile,
  parseNvidiaSmi,
  parseWindowsAdapters,
  classifyHardware
};
