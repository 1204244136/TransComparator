param(
  [ValidateSet("auto", "cuda", "rocm", "cpu")]
  [string]$Backend = "auto",

  [ValidateSet("cu128", "cu126", "cu118")]
  [string]$CudaWheel = "cu128",

  [string]$AmdGpuName,

  [switch]$Yes,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$AmdRocmVersion = "7.2.1"
$AmdRocmBaseUrl = "https://repo.radeon.com/rocm/windows/rocm-rel-$AmdRocmVersion"
$AmdSupportedGpuPatterns = @(
  "Radeon RX 9070 XT",
  "Radeon RX 9070",
  "Radeon RX 9060 XT",
  "Radeon AI PRO R9700",
  "Radeon RX 7900 XTX",
  "Radeon PRO W7900",
  "Radeon RX 7700"
)
$IsWindowsHost = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)

function Invoke-Step {
  param(
    [string]$Name,
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==> $Name"
  & $Action
}

function Invoke-NativeCommand {
  param(
    [string]$Command,
    [string[]]$Arguments,
    [string]$FailureMessage
  )

  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

function Confirm-Install {
  param([string]$Message)

  if ($DryRun) {
    Write-Host "Dry run: $Message"
    return
  }

  if ($Yes) {
    return
  }

  $answer = Read-Host "$Message [y/N]"
  if ($answer -notin @("y", "Y", "yes", "YES")) {
    throw "Cancelled by user."
  }
}

function Get-NvidiaDevices {
  $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if (-not $nvidiaSmi) {
    return @()
  }

  $lines = & $nvidiaSmi.Source -L 2>$null
  return @($lines | Where-Object { $_ -match "^GPU\s+\d+:" })
}

function Get-AmdDevices {
  if ($AmdGpuName) {
    return @($AmdGpuName)
  }

  $detectScript = Join-Path $Root "scripts\detect-accelerator.js"
  if (Test-Path -LiteralPath $detectScript) {
    try {
      $output = & node $detectScript 2>$null
      if ($LASTEXITCODE -eq 0) {
        $text = $output -join "`n"
        $jsonMatch = [regex]::Match($text, "(?s)^\s*(\{.*?\n\})")
        if (-not $jsonMatch.Success) {
          throw "Could not parse detector JSON."
        }
        $detected = $jsonMatch.Groups[1].Value | ConvertFrom-Json
        if ($detected.amd) {
          return @($detected.amd)
        }
      }
    } catch {
      Write-Warning "Could not query AMD GPUs via detect-accelerator.js: $($_.Exception.Message)"
    }
  }

  if (-not $IsWindowsHost) {
    return @()
  }

  try {
    $names = Get-CimInstance Win32_VideoController -ErrorAction Stop |
      Select-Object -ExpandProperty Name |
      Where-Object { $_ -match "AMD|Radeon|Instinct" }

    return @($names)
  } catch {
    Write-Warning "Could not query AMD GPUs via Win32_VideoController: $($_.Exception.Message)"
    return @()
  }
}

function Get-SelectedBackend {
  if ($Backend -ne "auto") {
    return $Backend
  }

  if ((Get-NvidiaDevices).Count -gt 0) {
    return "cuda"
  }

  if ((Get-AmdDevices).Count -gt 0) {
    return "rocm"
  }

  return "cpu"
}

function Install-CudaTorch {
  $indexUrl = "https://download.pytorch.org/whl/$CudaWheel"
  Write-Host "Selected PyTorch CUDA wheel index: $indexUrl"
  Confirm-Install "Install CUDA PyTorch into .venv?"
  if ($DryRun) {
    Write-Host "Dry run: would install torch torchvision torchaudio from $indexUrl"
    return
  }

  Invoke-NativeCommand `
    -Command $VenvPython `
    -Arguments @("-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio") `
    -FailureMessage "Failed to uninstall existing PyTorch packages."

  Invoke-NativeCommand `
    -Command $VenvPython `
    -Arguments @("-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", $indexUrl) `
    -FailureMessage "Failed to install CUDA PyTorch packages."
}

function Install-CpuTorch {
  Confirm-Install "Install CPU PyTorch into .venv?"
  if ($DryRun) {
    Write-Host "Dry run: would install CPU torch torchvision torchaudio from PyPI"
    return
  }

  Invoke-NativeCommand `
    -Command $VenvPython `
    -Arguments @("-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio") `
    -FailureMessage "Failed to uninstall existing PyTorch packages."

  Invoke-NativeCommand `
    -Command $VenvPython `
    -Arguments @("-m", "pip", "install", "torch", "torchvision", "torchaudio") `
    -FailureMessage "Failed to install CPU PyTorch packages."
}

function Get-SupportedAmdDevices {
  $devices = Get-AmdDevices
  return @($devices | Where-Object {
    $device = $_
    $AmdSupportedGpuPatterns | Where-Object { $device -match [regex]::Escape($_) }
  })
}

function Install-WindowsRocmTorch {
  if (-not $IsWindowsHost) {
    throw "Automatic ROCm PyTorch installation is only implemented for Windows Radeon wheels. Use the official PyTorch ROCm selector on Linux."
  }

  $supportedDevices = Get-SupportedAmdDevices
  if ($supportedDevices.Count -eq 0) {
    Write-Host "No AMD Radeon GPU supported by the Windows ROCm $AmdRocmVersion matrix was detected."
    Write-Host "Supported patterns in this script:"
    foreach ($pattern in $AmdSupportedGpuPatterns) {
      Write-Host "  - $pattern"
    }
    throw "Refusing to install ROCm PyTorch for an unsupported or unknown AMD GPU. If detection failed but your GPU is supported, rerun with -AmdGpuName."
  }

  Write-Host "Supported AMD device(s):"
  foreach ($device in $supportedDevices) {
    Write-Host "  - $device"
  }
  Write-Host "AMD ROCm Windows wheel set: $AmdRocmVersion"
  Write-Host "Required driver: AMD Software: Adrenalin Edition 26.2.2 or newer for ROCm $AmdRocmVersion."
  Confirm-Install "Install AMD ROCm PyTorch into .venv?"
  if ($DryRun) {
    Write-Host "Dry run: would install AMD ROCm SDK and PyTorch wheels from $AmdRocmBaseUrl"
    return
  }

  Invoke-NativeCommand `
    -Command $VenvPython `
    -Arguments @("-m", "pip", "uninstall", "-y", "torch", "torchvision", "torchaudio") `
    -FailureMessage "Failed to uninstall existing PyTorch packages."

  Invoke-NativeCommand `
    -Command $VenvPython `
    -Arguments @(
      "-m", "pip", "install", "--no-cache-dir",
      "$AmdRocmBaseUrl/rocm_sdk_core-$AmdRocmVersion-py3-none-win_amd64.whl",
      "$AmdRocmBaseUrl/rocm_sdk_devel-$AmdRocmVersion-py3-none-win_amd64.whl",
      "$AmdRocmBaseUrl/rocm_sdk_libraries_custom-$AmdRocmVersion-py3-none-win_amd64.whl",
      "$AmdRocmBaseUrl/rocm-$AmdRocmVersion.tar.gz"
    ) `
    -FailureMessage "Failed to install AMD ROCm SDK Python packages."

  Invoke-NativeCommand `
    -Command $VenvPython `
    -Arguments @(
      "-m", "pip", "install", "--no-cache-dir",
      "$AmdRocmBaseUrl/torch-2.9.1%2Brocm$AmdRocmVersion-cp312-cp312-win_amd64.whl",
      "$AmdRocmBaseUrl/torchaudio-2.9.1%2Brocm$AmdRocmVersion-cp312-cp312-win_amd64.whl",
      "$AmdRocmBaseUrl/torchvision-0.24.1%2Brocm$AmdRocmVersion-cp312-cp312-win_amd64.whl"
    ) `
    -FailureMessage "Failed to install AMD ROCm PyTorch packages."
}

try {
  Set-Location -LiteralPath $Root

  if (-not (Test-Path -LiteralPath $VenvPython)) {
    throw ".venv was not found. Run npm run setup:env first."
  }

  Invoke-Step "Detected accelerators" {
    $nvidia = Get-NvidiaDevices
    $amd = Get-AmdDevices

    Write-Host "NVIDIA devices: $($nvidia.Count)"
    foreach ($device in $nvidia) {
      Write-Host "  - $device"
    }

    Write-Host "AMD devices: $($amd.Count)"
    foreach ($device in $amd) {
      Write-Host "  - $device"
    }
  }

  $selected = Get-SelectedBackend
  Write-Host ""
  Write-Host "Selected accelerator backend: $selected"

  switch ($selected) {
    "cuda" {
      Invoke-Step "Installing CUDA PyTorch" {
        Install-CudaTorch
      }
    }
    "rocm" {
      Invoke-Step "Installing AMD ROCm PyTorch" {
        Install-WindowsRocmTorch
      }
    }
    "cpu" {
      Invoke-Step "Installing CPU PyTorch" {
        Install-CpuTorch
      }
    }
  }

  if (-not $DryRun) {
    Invoke-Step "Checking accelerator" {
      Invoke-NativeCommand `
        -Command "npm" `
        -Arguments @("run", "check:accelerator") `
        -FailureMessage "Accelerator check failed."
    }
  }
} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
