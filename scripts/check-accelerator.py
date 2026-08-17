import os
import sys

import torch

from accelerator_detect import expected_backends, torch_backend


ALLOW_CPU = os.environ.get("TRANS_COMPARATOR_ALLOW_CPU") == "1"


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
