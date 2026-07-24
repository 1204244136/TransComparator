import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

import numpy as np
import torch

from sentence_transformers import SentenceTransformer


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "out"
PARAGRAPHS = OUT / "paragraphs.json"
ALIGNMENT = OUT / "jp-align.json"

MODEL_NAME = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
PIVOT_LANG = os.environ.get("TRANS_COMPARATOR_JP_PIVOT", "cn")
BATCH_SIZE = 32
SEARCH_WINDOW = 24
MAX_CHARS = 420
PROGRESS_ENV = os.environ.get("TRANS_COMPARATOR_PROGRESS")
SHOW_PROGRESS = PROGRESS_ENV.lower() not in ("0", "false", "no") if PROGRESS_ENV is not None else sys.stderr.isatty()
MOVES = (
    (1, 1),
    (1, 2),
    (2, 1),
    (2, 2),
    (1, 0),
    (0, 1),
)


def configure_console_output() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except OSError:
                pass


def configure_progress_output() -> None:
    from transformers.utils import logging as transformers_logging

    if SHOW_PROGRESS:
        transformers_logging.enable_progress_bar()
    else:
        transformers_logging.disable_progress_bar()


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

    if result.returncode != 0:
        return ""

    return result.stdout


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


def select_device() -> str:
    print(f"torch: {torch.__version__}")
    print(f"torch.version.cuda: {torch.version.cuda}")
    print(f"torch.version.hip: {getattr(torch.version, 'hip', None)}")

    if torch.cuda.is_available():
        return "cuda"

    expected = expected_backends()
    if expected:
        print(
            "warning: GPU accelerator hardware detected, but PyTorch cannot use it. "
            "This usually means a CPU-only torch wheel or the wrong backend wheel is installed."
        )
        if os.environ.get("TRANS_COMPARATOR_ALLOW_CPU") != "1":
            raise RuntimeError(
                "Refusing to run cross-language alignment on CPU while accelerator hardware is present. "
                f"Expected backend(s): {', '.join(expected)}. Installed PyTorch backend: {torch_backend()}. "
                "Run `npm run check:accelerator` for diagnostics, install a matching CUDA/ROCm PyTorch wheel, "
                "or set TRANS_COMPARATOR_ALLOW_CPU=1 to run on CPU intentionally."
            )

    return "cpu"


def trimmed(text: str) -> str:
    chars = list(text or "")
    return "".join(chars[:MAX_CHARS])


def encode(model: SentenceTransformer, texts: list[str], device: str) -> np.ndarray:
    return model.encode(
        [trimmed(text) for text in texts],
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=SHOW_PROGRESS,
        device=device,
    )


def group_vector(vecs: np.ndarray, start: int, size: int) -> np.ndarray:
    group = vecs[start : start + size].mean(axis=0)
    norm = np.linalg.norm(group)
    return group if norm == 0 else group / norm


def group_score(jp_vecs: np.ndarray, tw_vecs: np.ndarray, jp_start: int, jp_size: int, tw_start: int, tw_size: int) -> float:
    if jp_size == 0 or tw_size == 0:
        return -0.26

    jp_group = group_vector(jp_vecs, jp_start, jp_size)
    tw_group = group_vector(tw_vecs, tw_start, tw_size)
    merge_penalty = 0.035 * max(0, jp_size + tw_size - 2)
    return float(jp_group @ tw_group) - merge_penalty


def align_groups(jp_vecs: np.ndarray, tw_vecs: np.ndarray) -> list[dict]:
    jp_count = len(jp_vecs)
    tw_count = len(tw_vecs)
    neg = -1e9
    dp = np.full((jp_count + 1, tw_count + 1), neg, dtype=np.float32)
    trace = np.full((jp_count + 1, tw_count + 1, 2), -1, dtype=np.int16)
    dp[0, 0] = 0

    for i in range(jp_count + 1):
        expected = round((i / max(1, jp_count)) * tw_count)
        j_start = max(0, expected - SEARCH_WINDOW)
        j_end = min(tw_count, expected + SEARCH_WINDOW)

        for j in range(j_start, j_end + 1):
            if dp[i, j] <= neg / 2:
                continue

            for jp_step, tw_step in MOVES:
                ni = i + jp_step
                nj = j + tw_step
                if ni > jp_count or nj > tw_count:
                    continue

                next_expected = round((ni / max(1, jp_count)) * tw_count)
                if abs(nj - next_expected) > SEARCH_WINDOW:
                    continue

                score = group_score(jp_vecs, tw_vecs, i, jp_step, j, tw_step)
                candidate = dp[i, j] + score
                if candidate > dp[ni, nj]:
                    dp[ni, nj] = candidate
                    trace[ni, nj] = (jp_step, tw_step)

    groups = []
    i = jp_count
    j = tw_count
    while i > 0 or j > 0:
        jp_step, tw_step = trace[i, j]
        if jp_step < 0 or tw_step < 0:
            if i > 0 and j > 0:
                jp_step, tw_step = 1, 1
            elif i > 0:
                jp_step, tw_step = 1, 0
            else:
                jp_step, tw_step = 0, 1

        jp_start = i - int(jp_step)
        tw_start = j - int(tw_step)
        score = group_score(jp_vecs, tw_vecs, jp_start, int(jp_step), tw_start, int(tw_step))
        groups.append(
            {
                "jpStart": jp_start,
                "jpEnd": i,
                "twStart": tw_start,
                "twEnd": j,
                "score": round(float(score), 4),
                "relation": f"{int(jp_step)}:{int(tw_step)}",
            }
        )
        i = jp_start
        j = tw_start

    groups.reverse()
    return groups


def align(jp_vecs: np.ndarray, tw_vecs: np.ndarray) -> list[dict]:
    jp_count = len(jp_vecs)
    tw_count = len(tw_vecs)
    mapping = []
    last_tw = 0

    for jp_idx in range(jp_count):
        expected = round((jp_idx / max(1, jp_count - 1)) * (tw_count - 1))
        center = max(expected, last_tw)
        start = max(0, center - SEARCH_WINDOW)
        end = min(tw_count - 1, center + SEARCH_WINDOW)

        candidates = tw_vecs[start : end + 1]
        sims = candidates @ jp_vecs[jp_idx]
        penalties = np.array(
            [
                (max(0, last_tw - tw_idx) * 0.018) + (abs(tw_idx - expected) * 0.003)
                for tw_idx in range(start, end + 1)
            ],
            dtype=np.float32,
        )
        best_local = int(np.argmax(sims - penalties))
        best_tw = start + best_local
        last_tw = max(last_tw, best_tw)

        mapping.append(
            {
                "jpIndex": jp_idx,
                "twIndex": best_tw,
                "score": round(float(sims[best_local]), 4),
            }
        )

    return mapping


def main() -> None:
    data = json.loads(PARAGRAPHS.read_text(encoding="utf-8"))
    jp = data["jp"]
    comparison_mode = data.get("comparisonMode", "trilingual")
    pivot_lang = "cn" if comparison_mode == "bilingual" else PIVOT_LANG
    if pivot_lang not in data:
        raise ValueError(f"Unknown pivot language: {pivot_lang}")
    pivot = data[pivot_lang]

    device = select_device()
    print(f"device: {device}")
    if device == "cuda":
        print(f"gpu: {torch.cuda.get_device_name(0)}")

    model = SentenceTransformer(MODEL_NAME, device=device)
    jp_texts = [item["text"] for item in jp]
    pivot_texts = [item["cnText"] for item in pivot]

    print("encoding jp")
    jp_vecs = encode(model, jp_texts, device)
    print(f"encoding {pivot_lang}")
    pivot_vecs = encode(model, pivot_texts, device)

    mapping = align(jp_vecs, pivot_vecs)
    groups = align_groups(jp_vecs, pivot_vecs)
    for item in mapping:
        item["pivotIndex"] = item["twIndex"]
    for group in groups:
        group["pivotStart"] = group["twStart"]
        group["pivotEnd"] = group["twEnd"]
    result = {
        "model": MODEL_NAME,
        "pivotLang": pivot_lang,
        "comparisonMode": comparison_mode,
        "device": device,
        "torchVersion": torch.__version__,
        "torchCudaVersion": torch.version.cuda,
        "torchHipVersion": getattr(torch.version, "hip", None),
        "acceleratorBackend": torch_backend(),
        "gpu": torch.cuda.get_device_name(0) if device == "cuda" else None,
        "searchWindow": SEARCH_WINDOW,
        "counts": {"jp": len(jp), pivot_lang: len(pivot)},
        "mapping": mapping,
        "groups": groups,
    }
    ALIGNMENT.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {ALIGNMENT}")


if __name__ == "__main__":
    configure_console_output()
    configure_progress_output()
    main()
