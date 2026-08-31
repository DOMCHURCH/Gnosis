<#
.SYNOPSIS
  Install Gnosis - downloads the latest Windows installer and runs it.

.DESCRIPTION
  The one-command path onto a fresh machine:

      irm https://raw.githubusercontent.com/DOMCHURCH/Gnosis/master/scripts/install.ps1 | iex

  It resolves the newest release from the GitHub API (rather than hard-coding a
  version that goes stale the next time one ships), downloads the installer, and
  launches it. Then it reports what else this machine would need for the optional
  parts - Node.js for MCP servers, Python for voice - because those are what a
  fresh install is actually missing, and finding out one feature at a time is how
  people conclude the app is broken.

  It installs NOTHING but Gnosis. Node and Python are named and linked, never
  silently placed on someone's machine.

  ASCII ONLY, deliberately. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it
  carries a UTF-8 BOM, and a BOM does not survive `irm | iex` at all - the content
  arrives decoded by whatever the response headers claimed. A single em dash in a
  comment is therefore enough to mangle a string and cascade into a wall of parse
  errors that name the wrong lines. Keep every character in this file 7-bit.

.PARAMETER DownloadOnly
  Download and verify the installer, but do not run it. Prints the path.

.PARAMETER OutDir
  Where to put the downloaded installer. Defaults to the temp directory.

.PARAMETER Cli
  Install the CLI from npm instead of the desktop app. Requires Node.js.

.EXAMPLE
  irm https://raw.githubusercontent.com/DOMCHURCH/Gnosis/master/scripts/install.ps1 | iex

.EXAMPLE
  # Pass options through the one-liner (irm | iex cannot take parameters directly)
  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/DOMCHURCH/Gnosis/master/scripts/install.ps1))) -DownloadOnly
#>
[CmdletBinding()]
param(
  [switch]$DownloadOnly,
  [string]$OutDir = $env:TEMP,
  [switch]$Cli
)

$ErrorActionPreference = 'Stop'

$REPO = 'DOMCHURCH/Gnosis'
$PKG = '@dominquechurch/gnosis'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Good($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Miss($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Note($msg) { Write-Host "    $msg" -ForegroundColor DarkGray }

# Is a command actually on PATH? Used only to REPORT what is missing.
function Test-Have($name) {
  $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host '  GNOSIS' -ForegroundColor Cyan
Write-Host '  a terminal coding agent' -ForegroundColor DarkGray
Write-Host ''

# --------------------------------------------------------------- the CLI path
if ($Cli) {
  Write-Step 'Installing the CLI from npm'
  if (-not (Test-Have 'npm')) {
    Write-Miss 'npm was not found. Install Node.js LTS first: https://nodejs.org/en/download'
    return
  }
  npm install -g $PKG
  if ($LASTEXITCODE -ne 0) { Write-Miss "npm install failed (exit $LASTEXITCODE)."; return }
  Write-Good "Installed. Run 'gnosis' in any project directory."
  Write-Host ''
  Write-Note 'You still need an OpenRouter key: https://openrouter.ai/keys'
  Write-Note 'Put it in ~/.dom/.env as  OPENROUTER_API_KEY=sk-or-...'
  return
}

# ------------------------------------------------------- resolve the release
# TLS 1.2 explicitly: Windows PowerShell 5.1 still defaults to SSL3/TLS1.0 on
# some machines, and GitHub refuses those outright - which surfaces as a bare
# "underlying connection was closed" rather than anything about TLS.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

Write-Step 'Finding the latest release'
try {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest" `
    -Headers @{ 'User-Agent' = 'gnosis-install' } -TimeoutSec 30
} catch {
  Write-Miss "Could not reach the GitHub API: $($_.Exception.Message)"
  Write-Note "Download it manually: https://github.com/$REPO/releases/latest"
  return
}

$asset = $rel.assets | Where-Object { $_.name -like 'Gnosis-Setup-*.exe' } | Select-Object -First 1
if (-not $asset) {
  Write-Miss "Release $($rel.tag_name) has no Windows installer attached."
  Write-Note "See https://github.com/$REPO/releases/latest"
  return
}
$sizeMb = [math]::Round($asset.size / 1MB)
Write-Good "$($rel.tag_name) - $($asset.name), $sizeMb MB"

# ------------------------------------------------------------------ download
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$dest = Join-Path $OutDir $asset.name

Write-Step 'Downloading'
try {
  # Invoke-WebRequest's progress bar makes a large download roughly an order of
  # magnitude slower in 5.1; the write is what we want, not the animation.
  $prevProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $dest -TimeoutSec 1800 `
    -Headers @{ 'User-Agent' = 'gnosis-install' }
} catch {
  Write-Miss "Download failed: $($_.Exception.Message)"
  return
} finally {
  $ProgressPreference = $prevProgress
}

# A truncated download that still "succeeded" is the classic failure here, and
# it fails much later as a corrupt-installer error that names the wrong thing.
$actual = (Get-Item $dest).Length
if ($actual -ne $asset.size) {
  Write-Miss "Downloaded $actual bytes, expected $($asset.size). Deleting the partial file."
  Remove-Item $dest -Force -ErrorAction SilentlyContinue
  return
}
Write-Good "Saved to $dest"

if ($DownloadOnly) {
  Write-Host ''
  Write-Note 'Not running it (-DownloadOnly). Run it yourself when ready:'
  Write-Note "  $dest"
  return
}

Write-Step 'Running the installer'
Start-Process -FilePath $dest
Write-Good 'Installer launched - follow the prompts.'

# --------------------------------------------- what this machine still needs
# Reported all at once, up front. Discovering these one feature at a time is
# how a working install gets reported as broken.
Write-Host ''
Write-Host '  NEXT' -ForegroundColor Cyan
Write-Host ''
Write-Host '  Required - one API key' -ForegroundColor White
Write-Note 'Gnosis runs on OpenRouter. On first launch it opens a setup page with'
Write-Note 'Settings behind it - paste your key there, then restart.'
Write-Note 'Get one: https://openrouter.ai/keys'
Write-Host ''
Write-Host '  Optional' -ForegroundColor White

if (Test-Have 'npx') {
  Write-Good 'Node.js found - MCP servers (docs, browser and desktop control) will work.'
} else {
  Write-Miss 'Node.js missing - MCP servers cannot start (they all launch through npx).'
  Write-Note 'Install the LTS build: https://nodejs.org/en/download'
}

$py = $null
foreach ($c in @('py', 'python', 'python3')) { if (Test-Have $c) { $py = $c; break } }
if ($py) {
  Write-Good "Python found ($py). Open Settings, then Voice, then Install voice support."
  Write-Note 'That button fetches openWakeWord, Kokoro and ~350MB of model weights.'
} else {
  Write-Miss 'Python missing - voice needs it.'
  Write-Note "Install from https://python.org/downloads (tick 'Add python.exe to PATH'),"
  Write-Note 'then use Settings, Voice, Install voice support.'
}

Write-Note 'Speech-to-text also needs GROQ_API_KEY (Settings, Keys). The wake word'
Write-Note 'and the spoken replies are local and free.'
Write-Host ''
