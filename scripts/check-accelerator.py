import os
import platform
import shutil
import subprocess
import sys

import torch


ALLOW_CPU = os.environ.get("TRANS_COMPARATOR_ALLOW_CPU") == "1"


def command_output(command: list[str]) -> str:
    if not shutil.which(command[0]):
        return ""

    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return ""

    return result.stdout if result.returncode == 0 else ""


def nvidia_devices() -> list[str]:
    output = command_output(["nvidia-smi", "-L"])
    return [line.strip() for line in output.splitlines() if line.strip().startswith("GPU ")]


def amd_devices() -> list[str]:
    devices = []

    for command in (["rocm-smi", "--showproductname"], ["rocminfo"]):
        output = command_output(command)
        for line in output.splitlines():
            stripped = line.strip()
            if any(token in stripped.lower() for token in ("amd", "radeon", "instinct", "gfx")):
                devices.append(stripped)

    if platform.system() == "Windows":
        output = command_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
            ]
        )
        for line in output.splitlines():
            stripped = line.strip()
            if any(token in stripped.lower() for token in ("amd", "radeon", "instinct")):
                devices.append(stripped)
    else:
        output = command_output(["lspci"])
        for line in output.splitlines():
            lower = line.lower()
            if any(token in lower for token in ("amd", "ati", "radeon", "instinct")) and any(
                token in lower for token in ("vga", "3d", "display")
            ):
                devices.append(line.strip())

    return sorted(set(devices))


def torch_backend() -> str:
    if getattr(torch.version, "hip", None):
        return "rocm"
    if torch.version.cuda:
        return "cuda"
    if torch.cuda.is_available():
        return "accelerator"
    return "cpu"


def expected_backends() -> list[str]:
    backends = []
    if nvidia_devices():
        backends.append("cuda")
    if amd_devices():
        backends.append("rocm")
    return backends


def device_name() -> str | None:
    if not torch.cuda.is_available():
        return None

    try:
        return torch.cuda.get_device_name(0)
    except Exception:
        return None


def main() -> int:
    backend = torch_backend()
    expected = expected_backends()
    accelerator_available = torch.cuda.is_available()
    gpu_name = device_name()

    print(f"torch: {torch.__version__}")
    print(f"torch.version.cuda: {torch.version.cuda}")
    print(f"torch.version.hip: {getattr(torch.version, 'hip', None)}")
    print(f"torch accelerator built: {backend != 'cpu'}")
    print(f"torch accelerator available: {accelerator_available}")
    print(f"detected accelerator backends: {', '.join(expected) if expected else 'none'}")

    if accelerator_available:
        print(f"accelerator backend: {backend}")
        if gpu_name:
            print(f"gpu: {gpu_name}")
        return 0

    if expected and not ALLOW_CPU:
        print(
            "\nGPU accelerator hardware was detected, but this Python environment cannot use it.",
            file=sys.stderr,
        )
        print(
            f"Expected backend(s): {', '.join(expected)}. Installed PyTorch backend: {backend}.",
            file=sys.stderr,
        )
        print(
            "Install a matching PyTorch CUDA/ROCm wheel, or set TRANS_COMPARATOR_ALLOW_CPU=1 to run on CPU intentionally.",
            file=sys.stderr,
        )
        return 1

    if expected:
        print("GPU accelerator hardware detected, but CPU mode was explicitly allowed.")
    else:
        print("No NVIDIA CUDA or AMD ROCm accelerator was detected by local probes; CPU mode is expected.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
