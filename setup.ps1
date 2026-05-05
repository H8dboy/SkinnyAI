# ============================================================
# Setup — run ONCE
# Adds `skinny` to PATH and downloads the required models
# ============================================================
$ErrorActionPreference = "Stop"
$ARCH_DIR = $PSScriptRoot

Write-Host ""
Write-Host "=== AI Architecture 8GB — Setup ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Set permanent Ollama environment variables ─────────────────────────────
Write-Host "[1/4] Setting Ollama environment variables..." -ForegroundColor Yellow
[System.Environment]::SetEnvironmentVariable("OLLAMA_MAX_LOADED_MODELS", "1",   "User")
[System.Environment]::SetEnvironmentVariable("OLLAMA_NUM_PARALLEL",      "1",   "User")
[System.Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE",        "10m", "User")
[System.Environment]::SetEnvironmentVariable("OLLAMA_NUM_THREADS",       "$([Environment]::ProcessorCount)", "User")
$env:OLLAMA_MAX_LOADED_MODELS = "1"
$env:OLLAMA_NUM_PARALLEL      = "1"
$env:OLLAMA_KEEP_ALIVE        = "10m"
$env:OLLAMA_NUM_THREADS       = [Environment]::ProcessorCount
Write-Host "   Done" -ForegroundColor Green

# ── 2. Add ai-arch-8gb to user PATH ──────────────────────────────────────────
Write-Host "[2/4] Adding 'skinny' to PATH..." -ForegroundColor Yellow
$currentPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $currentPath) { $currentPath = "" }
if ($currentPath -notlike "*$ARCH_DIR*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$currentPath;$ARCH_DIR", "User")
    $env:PATH = "$env:PATH;$ARCH_DIR"
    Write-Host "   Added: $ARCH_DIR" -ForegroundColor Green
} else {
    Write-Host "   Already in PATH." -ForegroundColor DarkGray
}

# ── 3. Restart Ollama with new variables ──────────────────────────────────────
Write-Host "[3/4] Restarting Ollama..." -ForegroundColor Yellow
Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 4
Write-Host "   Done" -ForegroundColor Green

# ── 4. Download models ────────────────────────────────────────────────────────
Write-Host "[4/4] Downloading Ollama models..." -ForegroundColor Yellow
$models = (Invoke-RestMethod -Uri "http://localhost:11434/api/tags").models.name

if (-not ($models -like "*phi4-mini*")) {
    Write-Host "   phi4-mini (~2.5 GB)..." -ForegroundColor DarkYellow
    & ollama pull phi4-mini
}
if (-not ($models -like "*qwen2.5-coder*")) {
    Write-Host "   qwen2.5-coder:1.5b (~1 GB)..." -ForegroundColor DarkYellow
    & ollama pull qwen2.5-coder:1.5b
}
if (-not ($models -like "*moondream*")) {
    Write-Host "   moondream (~1.7 GB)..." -ForegroundColor DarkYellow
    & ollama pull moondream
}
Write-Host "   All models ready." -ForegroundColor Green

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Setup complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Open a NEW terminal and type:" -ForegroundColor White
Write-Host "  skinny" -ForegroundColor Green
Write-Host ""
Write-Host "If cc-haha is in a custom path:" -ForegroundColor DarkGray
Write-Host "  set CCHAHA_DIR=C:\path\to\cc-haha-main && skinny" -ForegroundColor DarkGray
Write-Host ""
