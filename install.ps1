param(
  [switch]$NoHooks,  # skip the Claude Code notification hooks
  [switch]$NoPath    # skip adding the `lsum` command to your user PATH
)
# install.ps1 - installs/updates lsum: skill + global CLAUDE.md line + notification hooks + `lsum` command.
# Run from a clone:  powershell -ExecutionPolicy Bypass -File .\install.ps1
# Safe to re-run: every step is idempotent.
$ErrorActionPreference = 'Stop'
$src = if ($LSUM_SRC) { $LSUM_SRC } else { $PSScriptRoot }
$claudeDir = Join-Path $HOME '.claude'
$skillDir  = Join-Path $claudeDir 'skills\lsum'
$binDir    = Join-Path $HOME '.lsum\bin'
New-Item -ItemType Directory -Force -Path $skillDir, $binDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 1. skill files
Copy-Item (Join-Path $src 'skill\lsum.mjs') (Join-Path $skillDir 'lsum.mjs') -Force
Copy-Item (Join-Path $src 'skill\SKILL.md') (Join-Path $skillDir 'SKILL.md') -Force
Write-Host "Skill installed/updated in $skillDir"
if (-not $LSUM_SRC) { # installed from a clone: remember it for `lsum update`
  [IO.File]::WriteAllText((Join-Path $HOME '.lsum\source.txt'), $src, $utf8)
}

# 2. global CLAUDE.md line
$md = Join-Path $claudeDir 'CLAUDE.md'
$snippet = [IO.File]::ReadAllText((Join-Path $src 'claude-md-snippet.md'))
$current = if (Test-Path $md) { [IO.File]::ReadAllText($md) } else { '' }
if ($current -match '## Local output summarizer \(lsum\)') {
  Write-Host "CLAUDE.md already has the lsum section - left unchanged"
} else {
  [IO.File]::WriteAllText($md, $current + "`r`n" + $snippet, $utf8)
  Write-Host "Added lsum section to $md"
}

# 3. `lsum` command for cmd / PowerShell (lsum.cmd) and Git Bash (lsum)
if (-not $NoPath) {
  [IO.File]::WriteAllText((Join-Path $binDir 'lsum.cmd'), "@node `"%USERPROFILE%\.claude\skills\lsum\lsum.mjs`" %*`r`n", $utf8)
  [IO.File]::WriteAllText((Join-Path $binDir 'lsum'), "#!/bin/sh`nexec node `"`$HOME/.claude/skills/lsum/lsum.mjs`" `"`$@`"`n", $utf8)
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($userPath -split ';') -contains $binDir)) {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Added $binDir to your user PATH (open a NEW terminal to use 'lsum')"
  } else { Write-Host "$binDir already on PATH" }
  $env:Path = "$env:Path;$binDir"
}

# 4. hooks + health check
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Warning "Node.js not found in PATH - lsum needs Node 18+." }
else {
  if (-not $NoHooks) { node (Join-Path $skillDir 'lsum.mjs') install-hooks }
  Write-Host ""
  node (Join-Path $skillDir 'lsum.mjs') doctor
  Write-Host ""
  Write-Host "Done. Close and reopen your terminals and Claude Code. Remove hooks with: lsum uninstall-hooks"
}
