param(
  [switch]$SkipNode,
  [switch]$SkipPython,
  [switch]$SkipPandocCheck,
  [switch]$NoInstallPython,
  [switch]$NoInstallPandoc,
  [switch]$RecreateVenv
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$PythonVersion = "3.12"
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
$VenvPath = Join-Path $Root ".venv"
$Requirements = Join-Path $Root "requirements.txt"
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

function Test-PythonVersion {
  param(
    [string]$Command,
    [string[]]$Arguments = @()
  )

  try {
    $version = & $Command @Arguments -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    return ($LASTEXITCODE -eq 0) -and ($version -eq $PythonVersion)
  } catch {
    return $false
  }
}

function New-PythonCommand {
  param(
    [string]$Command,
    [string[]]$ArgList = @()
  )

  [PSCustomObject]@{
    Command = $Command
    ArgList = $ArgList
  }
}

function Install-RequiredPython {
  if ($NoInstallPython) {
    throw "Python $PythonVersion was not found. Install Python $PythonVersion manually, then run this script again."
  }

  if (-not $IsWindowsHost) {
    throw "Python $PythonVersion was not found. Automatic Python installation is only supported on Windows; install Python $PythonVersion manually, then run this script again."
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    throw "Python $PythonVersion was not found and winget is unavailable. Install Python $PythonVersion manually, then run this script again."
  }

  Write-Host "Python $PythonVersion was not found. Installing Python $PythonVersion with winget..."
  Invoke-NativeCommand `
    -Command $winget.Source `
    -Arguments @(
      "install",
      "--source", "winget",
      "--exact",
      "--id", "Python.Python.$PythonVersion",
      "--scope", "user",
      "--accept-package-agreements",
      "--accept-source-agreements"
    ) `
    -FailureMessage "winget failed to install Python $PythonVersion. Install Python $PythonVersion manually, then run this script again."
}

function Test-Pandoc {
  $pandoc = $env:PANDOC_BIN
  if (-not $pandoc) {
    $pandocCommand = Get-Command pandoc -ErrorAction SilentlyContinue
    if (-not $pandocCommand) {
      return $false
    }
    $pandoc = $pandocCommand.Source
  }

  & $pandoc --version *> $null
  return $LASTEXITCODE -eq 0
}

function Install-Pandoc {
  if (Test-Pandoc) {
    Write-Host "Pandoc already available."
    return
  }

  if ($NoInstallPandoc) {
    Write-Warning "Pandoc was not found. EPUB can fall back to the built-in reader, but DOCX/HTML/ODT/RTF inputs require Pandoc."
    return
  }

  if (-not $IsWindowsHost) {
    Write-Warning "Pandoc was not found. Automatic Pandoc installation is only supported on Windows; install Pandoc manually for non-EPUB inputs."
    return
  }

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Warning "Pandoc was not found and winget is unavailable. Install Pandoc manually for non-EPUB inputs."
    return
  }

  Write-Host "Pandoc was not found. Installing Pandoc with winget..."
  Invoke-NativeCommand `
    -Command $winget.Source `
    -Arguments @(
      "install",
      "--source", "winget",
      "--exact",
      "--id", "JohnMacFarlane.Pandoc",
      "--accept-package-agreements",
      "--accept-source-agreements"
    ) `
    -FailureMessage "winget failed to install Pandoc. Install Pandoc manually or set PANDOC_BIN to pandoc.exe."

  if (-not (Test-Pandoc)) {
    Write-Warning "Pandoc was installed but is not visible in this terminal yet. Open a new terminal or set PANDOC_BIN to pandoc.exe."
  }
}

function Get-RequiredPythonCommand {
  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher -and (Test-PythonVersion -Command $pyLauncher.Source -Arguments @("-$PythonVersion"))) {
    return New-PythonCommand -Command $pyLauncher.Source -ArgList @("-$PythonVersion")
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python -and (Test-PythonVersion -Command $python.Source)) {
    return New-PythonCommand -Command $python.Source
  }

  Install-RequiredPython

  $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
  if ($pyLauncher -and (Test-PythonVersion -Command $pyLauncher.Source -Arguments @("-$PythonVersion"))) {
    return New-PythonCommand -Command $pyLauncher.Source -ArgList @("-$PythonVersion")
  }

  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python -and (Test-PythonVersion -Command $python.Source)) {
    return New-PythonCommand -Command $python.Source
  }

  throw "Python $PythonVersion still cannot be found after installation. Open a new terminal and run this script again."
}

function New-ProjectVenv {
  if ((Test-Path -LiteralPath $VenvPath) -and $RecreateVenv) {
    $resolvedRoot = (Resolve-Path -LiteralPath $Root).Path
    $resolvedVenv = (Resolve-Path -LiteralPath $VenvPath).Path
    if (-not $resolvedVenv.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove .venv because it is outside the project root."
    }
    Remove-Item -LiteralPath $resolvedVenv -Recurse -Force
  }

  if (Test-Path -LiteralPath $VenvPython) {
    $version = & $VenvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    if ($version -ne $PythonVersion) {
      throw ".venv uses Python $version, but this project now requires Python $PythonVersion. Re-run with -RecreateVenv to rebuild it."
    }
    Write-Host "Python virtual environment already exists: .venv"
    return
  }

  $requiredPython = Get-RequiredPythonCommand
  Invoke-NativeCommand `
    -Command $requiredPython.Command `
    -Arguments ($requiredPython.ArgList + @("-m", "venv", ".venv")) `
    -FailureMessage "Failed to create .venv with Python $PythonVersion."

  if (-not (Test-Path -LiteralPath $VenvPython)) {
    throw "Virtual environment creation did not produce .venv\Scripts\python.exe."
  }
}

try {
  Set-Location -LiteralPath $Root

  if (-not $SkipNode) {
    Invoke-Step "Installing Node dependencies" {
      $npm = Get-Command npm -ErrorAction SilentlyContinue
      if (-not $npm) {
        throw "npm was not found. Install Node.js 18 or newer, then run this script again."
      }

      Invoke-NativeCommand `
        -Command $npm.Source `
        -Arguments @("install") `
        -FailureMessage "npm install failed."
    }
  }

  if (-not $SkipPython) {
    Invoke-Step "Creating Python virtual environment" {
      New-ProjectVenv
    }

    Invoke-Step "Installing Python dependencies" {
      if (-not (Test-Path -LiteralPath $Requirements)) {
        throw "requirements.txt was not found."
      }

      Invoke-NativeCommand `
        -Command $VenvPython `
        -Arguments @("-m", "pip", "install", "-U", "pip", "setuptools", "wheel") `
        -FailureMessage "Failed to upgrade pip, setuptools, and wheel."

      Invoke-NativeCommand `
        -Command $VenvPython `
        -Arguments @("-m", "pip", "install", "-r", $Requirements) `
        -FailureMessage "Failed to install Python dependencies from requirements.txt."
    }

    Invoke-Step "Checking Python version" {
      $version = & $VenvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"
      Write-Host "Python $version"
      if (-not $version.StartsWith("$PythonVersion.")) {
        Write-Warning "This project is documented for Python $PythonVersion. Recreate .venv with Python $PythonVersion if alignment dependencies behave unexpectedly."
      }
    }
  }

  if (-not $SkipPandocCheck) {
    Invoke-Step "Installing Pandoc if needed" {
      Install-Pandoc
    }

    Invoke-Step "Checking Pandoc" {
      Invoke-NativeCommand `
        -Command "npm" `
        -Arguments @("run", "check:pandoc") `
        -FailureMessage "Pandoc check failed. Install Pandoc or set PANDOC_BIN to pandoc.exe."
    }
  }

  Write-Host ""
  Write-Host "Environment setup complete."
  Write-Host "Optional GPU acceleration: npm run setup:accelerator"
  Write-Host "Start the local setup console: npm run setup"
} catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
