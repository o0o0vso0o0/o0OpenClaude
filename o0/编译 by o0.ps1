# AI Cursor
# Pack OpenClaude CLI + Web GUI into o0\Release (no TUI for GUI entry).
# Usage: .\"编译 by o0.cmd"
#        powershell -File .\"编译 by o0.ps1" -ForceNpm
#        powershell -File .\"编译 by o0.ps1" -ForceNodeRuntime

param(
  [switch]$ForceNpm,
  [switch]$ForceNodeRuntime
)

$ErrorActionPreference = "Stop"

$o0Dir = $PSScriptRoot
$repoRoot = Split-Path -Parent $o0Dir
$releaseDir = Join-Path $o0Dir "Release"
$guiSrc = Join-Path $o0Dir "GUI"
$guiRelease = Join-Path $releaseDir "gui"
$cacheDir = Join-Path $o0Dir ".cache"

# Pinned portable Node (win-x64). Bump intentionally when you want a newer runtime.
$NodeRuntimeVersion = "22.23.2"
$NodeRuntimeMinMajor = 22

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name. Install it and reopen the terminal."
  }
}

# AI Cursor
function Get-Sha256OrNull([string]$Path) {
  if (-not (Test-Path $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# AI Cursor
function Remove-PathIfExists([string]$Path) {
  if (Test-Path $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

# AI Cursor
function Copy-TreeReplace([string]$From, [string]$To) {
  Remove-PathIfExists $To
  Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
}

# AI Cursor
function Test-BundledNodeOk([string]$NodeExe, [int]$MinMajor) {
  if (-not (Test-Path $NodeExe)) { return $false }
  try {
    $ver = & $NodeExe --version 2>$null
    if (-not $ver) { return $false }
    $ver = $ver.ToString().Trim()
    if ($ver -notmatch '^v(\d+)\.') { return $false }
    return ([int]$Matches[1] -ge $MinMajor)
  } catch {
    return $false
  }
}

# AI Cursor — download official win-x64 zip once; keep Release\runtime\node across packs
function Ensure-NodeRuntime {
  param(
    [string]$ReleaseRoot,
    [string]$Version,
    [int]$MinMajor,
    [switch]$Force
  )

  $nodeHome = Join-Path $ReleaseRoot "runtime\node"
  $nodeExe = Join-Path $nodeHome "node.exe"
  $marker = Join-Path $nodeHome ".openclaude-node-version"

  if (-not $Force -and (Test-BundledNodeOk $nodeExe $MinMajor)) {
    $have = if (Test-Path $marker) { (Get-Content $marker -Raw).Trim() } else { "unknown" }
    Write-Host "==> Node runtime — skip (kept $nodeHome, version=$have)"
    return $nodeHome
  }

  $why = if ($Force) { "ForceNodeRuntime" } elseif (-not (Test-Path $nodeExe)) { "missing" } else { "invalid/outdated" }
  Write-Host "==> Node runtime — prepare v$Version ($why)"

  New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
  $zipName = "node-v$Version-win-x64.zip"
  $zipPath = Join-Path $cacheDir $zipName
  $url = "https://nodejs.org/dist/v$Version/$zipName"

  if (-not (Test-Path $zipPath)) {
    Write-Host "  downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  } else {
    Write-Host "  using cached zip: $zipPath"
  }

  $extractRoot = Join-Path $cacheDir "node-extract-$Version"
  Remove-PathIfExists $extractRoot
  New-Item -ItemType Directory -Path $extractRoot -Force | Out-Null
  Write-Host "  extracting..."
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force

  $extracted = Join-Path $extractRoot "node-v$Version-win-x64"
  if (-not (Test-Path (Join-Path $extracted "node.exe"))) {
    throw "Extracted Node zip missing node.exe under $extracted"
  }

  New-Item -ItemType Directory -Path (Join-Path $ReleaseRoot "runtime") -Force | Out-Null
  Remove-PathIfExists $nodeHome
  Move-Item -LiteralPath $extracted -Destination $nodeHome
  Remove-PathIfExists $extractRoot

  Set-Content -Path $marker -Value $Version -Encoding ASCII

  if (-not (Test-BundledNodeOk $nodeExe $MinMajor)) {
    throw "Bundled Node failed version check after install: $nodeExe"
  }

  Write-Host "  ready: $nodeExe"
  return $nodeHome
}

# AI Cursor
function Install-ReleaseNpmIfNeeded {
  param(
    [string]$Dir,
    [string]$Label,
    [string]$OldPkgHash,
    [string]$NewPkgPath,
    [string]$NodeHome,
    [switch]$Force
  )
  $modules = Join-Path $Dir "node_modules"
  $newHash = Get-Sha256OrNull $NewPkgPath
  $need = $Force -or -not (Test-Path $modules) -or ($OldPkgHash -ne $newHash)
  if (-not $need) {
    Write-Host "==> npm install --omit=dev ($Label) — skip (package.json unchanged, node_modules kept)"
    return
  }
  $why = if ($Force) { "ForceNpm" }
    elseif (-not (Test-Path $modules)) { "missing node_modules" }
    else { "package.json changed" }
  Write-Host "==> npm install --omit=dev ($Label) — $why"
  $npmCmd = Join-Path $NodeHome "npm.cmd"
  if (-not (Test-Path $npmCmd)) { throw "Bundled npm not found: $npmCmd" }
  Push-Location $Dir
  $oldPath = $env:PATH
  try {
    $env:PATH = "$NodeHome;$oldPath"
    & $npmCmd install --omit=dev --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw "$Label npm install --omit=dev failed ($LASTEXITCODE)" }
  }
  finally {
    $env:PATH = $oldPath
    Pop-Location
  }
}

Write-Host "==> Repo : $repoRoot"
Write-Host "==> Out  : $releaseDir"
if ($ForceNpm) { Write-Host "==> ForceNpm: will reinstall Release dependencies" }
if ($ForceNodeRuntime) { Write-Host "==> ForceNodeRuntime: will re-download portable Node" }

Assert-Command "node"
Assert-Command "npm"
Assert-Command "bun"

$nodeVer = (node --version).Trim()
if ($nodeVer -notmatch '^v(\d+)\.') { throw "Cannot parse node version: $nodeVer" }
$major = [int]$Matches[1]
if ($major -lt $NodeRuntimeMinMajor) { throw "Node.js >= $NodeRuntimeMinMajor required to pack, found $nodeVer" }

if (-not (Test-Path $guiSrc)) {
  throw "GUI project missing: $guiSrc"
}

Push-Location $repoRoot
try {
  Write-Host "==> bun install (OpenClaude)"
  bun install
  if ($LASTEXITCODE -ne 0) { throw "bun install failed ($LASTEXITCODE)" }

  Write-Host "==> bun run build (OpenClaude)"
  bun run build
  if ($LASTEXITCODE -ne 0) { throw "bun run build failed ($LASTEXITCODE)" }

  $cli = Join-Path $repoRoot "dist\cli.mjs"
  if (-not (Test-Path $cli)) { throw "Build succeeded but missing: $cli" }
}
finally {
  Pop-Location
}

Push-Location $guiSrc
try {
  Write-Host "==> npm install (GUI)"
  npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw "GUI npm install failed ($LASTEXITCODE)" }

  Write-Host "==> npm run build (GUI)"
  npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "GUI build failed ($LASTEXITCODE)" }

  $guiDist = Join-Path $guiSrc "dist\index.html"
  if (-not (Test-Path $guiDist)) { throw "GUI build missing: $guiDist" }
}
finally {
  Pop-Location
}

Write-Host "==> Prepare Release folder (keep node_modules / o0Data / runtime)"
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $guiRelease -Force | Out-Null

$nodeHome = Ensure-NodeRuntime -ReleaseRoot $releaseDir -Version $NodeRuntimeVersion `
  -MinMajor $NodeRuntimeMinMajor -Force:$ForceNodeRuntime

$cliPkgBefore = Get-Sha256OrNull (Join-Path $releaseDir "package.json")
$guiPkgBefore = Get-Sha256OrNull (Join-Path $guiRelease "package.json")

Copy-Item (Join-Path $repoRoot "package.json") (Join-Path $releaseDir "package.json") -Force
Write-Host "  updated package.json"

Copy-TreeReplace (Join-Path $repoRoot "bin") (Join-Path $releaseDir "bin")
Write-Host "  replaced bin"

Copy-TreeReplace (Join-Path $repoRoot "dist") (Join-Path $releaseDir "dist")
Write-Host "  replaced dist"

$vendor = Join-Path $repoRoot "vendor"
if (Test-Path $vendor) {
  Copy-TreeReplace $vendor (Join-Path $releaseDir "vendor")
  Write-Host "  replaced vendor"
} else {
  Remove-PathIfExists (Join-Path $releaseDir "vendor")
}

Write-Host "==> Update GUI into Release\gui (keep gui\node_modules)"
Copy-Item (Join-Path $guiSrc "package.json") (Join-Path $guiRelease "package.json") -Force
Copy-TreeReplace (Join-Path $guiSrc "server") (Join-Path $guiRelease "server")
Copy-TreeReplace (Join-Path $guiSrc "dist") (Join-Path $guiRelease "dist")
Write-Host "  updated GUI package.json, server, dist"

$cliLauncher = @"
@echo off
REM AI Cursor — OpenClaude CLI using bundled Node
setlocal
cd /d "%~dp0"
"%~dp0runtime\node\node.exe" "%~dp0bin\openclaude" %*
"@
Set-Content -Path (Join-Path $releaseDir "openclaude.cmd") -Value $cliLauncher -Encoding ASCII

$guiLauncher = @"
@echo off
REM AI Cursor — OpenClaude Web GUI (no TUI, no console)
REM Starts hidden via VBS; uses bundled Node under runtime\node
REM Close the browser tab to stop the server.
wscript //nologo "%~dp0OpenClaude-GUI.vbs"
"@
Set-Content -Path (Join-Path $releaseDir "OpenClaude-GUI.cmd") -Value $guiLauncher -Encoding ASCII

$guiVbs = @"
' AI Cursor — OpenClaude Web GUI launcher (no console window)
Option Explicit
Dim sh, fso, root, gui, dataDir, nodeExe, cmd, q
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
gui = root & "\gui"
dataDir = root & "\o0Data"
nodeExe = root & "\runtime\node\node.exe"
q = Chr(34)
If Not fso.FileExists(nodeExe) Then
  MsgBox "Bundled Node not found:" & vbCrLf & nodeExe & vbCrLf & "Re-run 「编译 by o0」.", 16, "OpenClaude GUI"
  WScript.Quit 1
End If
If Not fso.FolderExists(dataDir) Then fso.CreateFolder(dataDir)
sh.CurrentDirectory = gui
cmd = "cmd /c set OPENCLAUDE_GUI_OPEN=1&& set OPENCLAUDE_GUI_DATA=" & dataDir & "&& " & q & nodeExe & q & " server\server.mjs"
sh.Run cmd, 0, False
"@
Set-Content -Path (Join-Path $releaseDir "OpenClaude-GUI.vbs") -Value $guiVbs -Encoding ASCII

Install-ReleaseNpmIfNeeded -Dir $releaseDir -Label "CLI Release" `
  -OldPkgHash $cliPkgBefore -NewPkgPath (Join-Path $releaseDir "package.json") `
  -NodeHome $nodeHome -Force:$ForceNpm

Install-ReleaseNpmIfNeeded -Dir $guiRelease -Label "GUI Release" `
  -OldPkgHash $guiPkgBefore -NewPkgPath (Join-Path $guiRelease "package.json") `
  -NodeHome $nodeHome -Force:$ForceNpm

Write-Host ""
Write-Host "Done. Production package:"
Write-Host "  $releaseDir"
Write-Host "  Bundled Node: $nodeHome"
Write-Host ""
Write-Host "Web GUI (recommended, no TUI):"
Write-Host "  $releaseDir\OpenClaude-GUI.cmd"
Write-Host "CLI TUI (optional):"
Write-Host "  $releaseDir\openclaude.cmd"
Write-Host "Force reinstall deps:  powershell -File .\"编译 by o0.ps1" -ForceNpm"
Write-Host "Force refresh Node:    powershell -File .\"编译 by o0.ps1" -ForceNodeRuntime"
