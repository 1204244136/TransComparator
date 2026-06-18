const { execFileSync } = require("child_process");
const os = require("os");

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: options.timeout || 10000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function lines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(items) {
  return [...new Set(items)];
}

function detectWindowsHipSdk() {
  if (os.platform() !== "win32") return [];

  const roots = [
    process.env.HIP_PATH,
    process.env.HIPSDK_PATH,
    process.env.ROCM_PATH,
    "C:\\Program Files\\AMD\\ROCm",
  ].filter(Boolean);

  const found = [];
  for (const root of unique(roots)) {
    const output = run("powershell", [
      "-NoProfile",
      "-Command",
      `if (Test-Path '${root}') { Get-ChildItem -Path '${root}' -Recurse -Filter hipInfo.exe -ErrorAction SilentlyContinue | Select-Object -First 3 -ExpandProperty FullName }`,
    ]);
    found.push(...lines(output));
  }

  return unique(found);
}

function detectNvidia() {
  return lines(run("nvidia-smi", ["-L"]))
    .filter((line) => /^GPU\s+\d+:/i.test(line))
    .map((line) => line.replace(/^GPU\s+\d+:\s*/i, "").replace(/\s+\(UUID:.*\)$/i, ""));
}

function detectAmdFromRocmTools() {
  const rocmSmi = lines(run("rocm-smi", ["--showproductname"]));
  const rocminfo = lines(run("rocminfo", []));
  const names = [];

  for (const line of rocmSmi) {
    if (/card\d+/i.test(line) && /gpu|amd|radeon|instinct/i.test(line)) names.push(line);
  }

  for (const line of rocminfo) {
    const match = line.match(/Marketing Name:\s*(.+)$/i) || line.match(/Name:\s*(gfx[0-9a-f]+)/i);
    if (match) names.push(match[1].trim());
  }

  return names;
}

function detectAmdFromSystem() {
  const names = [];

  if (os.platform() === "win32") {
    const ps = run("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
    ]);
    names.push(...lines(ps).filter((line) => /amd|radeon|instinct/i.test(line)));

    const wmic = run("wmic", ["path", "win32_VideoController", "get", "name"]);
    names.push(...lines(wmic).filter((line) => /amd|radeon|instinct/i.test(line)));
  } else {
    const lspci = run("lspci", []);
    names.push(...lines(lspci).filter((line) => /amd|ati|radeon|instinct/i.test(line) && /vga|3d|display/i.test(line)));
  }

  return names;
}

function detect() {
  return {
    platform: os.platform(),
    nvidia: unique(detectNvidia()),
    amd: unique([...detectAmdFromRocmTools(), ...detectAmdFromSystem()]),
    hipSdk: detectWindowsHipSdk(),
  };
}

function main() {
  const result = detect();
  const accelerators = [];

  for (const name of result.nvidia) accelerators.push({ vendor: "nvidia", name, backend: "cuda" });
  for (const name of result.amd) accelerators.push({ vendor: "amd", name, backend: "rocm" });

  console.log(JSON.stringify({ ...result, accelerators }, null, 2));

  if (!accelerators.length) {
    console.log("No NVIDIA CUDA or AMD ROCm-capable accelerator was detected by local probes.");
  } else {
    for (const item of accelerators) {
      console.log(`${item.vendor.toUpperCase()} accelerator candidate: ${item.name}`);
    }
  }

  if (result.hipSdk.length) {
    for (const path of result.hipSdk) console.log(`Windows HIP SDK tool found: ${path}`);
  }
}

main();
