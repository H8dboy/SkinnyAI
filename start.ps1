# ============================================================
# AI Architecture 8GB RAM — startup script
# Starts: Ollama (optimized) + proxy + screen-watcher + cc-haha
# ============================================================
param(
    [string]$CcHahaPath = $env:CCHAHA_DIR
)

$ErrorActionPreference = "Stop"
$ROOT = $PSScriptRoot

# ── 1. Ollama variables — one model in RAM at a time ──────────────────────────
$env:OLLAMA_MAX_LOADED_MODELS = "1"   # automatic swap, never two models at once
$env:OLLAMA_NUM_PARALLEL      = "1"   # one request at a time → no RAM contention
$env:OLLAMA_KEEP_ALIVE        = "2m"  # unload model after 2 min of inactivity

# ── 2. Restart Ollama with new variables ──────────────────────────────────────
Write-Host "[start] Restarting Ollama with optimized settings..." -ForegroundColor Cyan
$ollamaProc = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
if ($ollamaProc) {
    Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
    $null = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 10
    Write-Host "[start] Ollama ready." -ForegroundColor Green
} catch {
    Write-Host "[start] ERROR: Ollama not responding. Make sure it is installed." -ForegroundColor Red
    exit 1
}

# ── 3. Pull models if not present ─────────────────────────────────────────────
$models = (Invoke-RestMethod -Uri "http://localhost:11434/api/tags").models.name
if (-not ($models -like "*phi4-mini*")) {
    Write-Host "[start] Downloading phi4-mini (~2.5 GB, first time)..." -ForegroundColor Yellow
    & ollama pull phi4-mini
}
if (-not ($models -like "*qwen2.5-coder*")) {
    Write-Host "[start] Downloading qwen2.5-coder:1.5b (~1 GB, first time)..." -ForegroundColor Yellow
    & ollama pull qwen2.5-coder:1.5b
}
if (-not ($models -like "*moondream*")) {
    Write-Host "[start] Downloading moondream (~1.7 GB, first time)..." -ForegroundColor Yellow
    & ollama pull moondream
}

# ── 4. Proxy (background) ─────────────────────────────────────────────────────
Write-Host "[start] Starting Anthropic→Ollama proxy..." -ForegroundColor Cyan
Start-Process -FilePath "bun" -ArgumentList "proxy.ts" -WorkingDirectory $ROOT -WindowStyle Hidden

Start-Sleep -Seconds 2
try {
    $health = Invoke-RestMethod -Uri "http://localhost:4000/health" -TimeoutSec 5
    Write-Host "[start] Proxy ok — model: $($health.model)" -ForegroundColor Green
} catch {
    Write-Host "[start] WARNING: proxy not responding." -ForegroundColor Yellow
}

# ── 5. Screen watcher (background) ───────────────────────────────────────────
Write-Host "[start] Starting screen watcher..." -ForegroundColor Cyan
Start-Process -FilePath "bun" -ArgumentList "screen-watcher.ts" -WorkingDirectory $ROOT -WindowStyle Hidden
Write-Host "[start] Screen watcher running in background." -ForegroundColor Green

# ── 6. cc-haha (foreground) ──────────────────────────────────────────────────
if (-not $CcHahaPath) {
    Write-Host "[start] ERROR: CCHAHA_DIR is not set." -ForegroundColor Red
    Write-Host "        Run: set CCHAHA_DIR=C:\path\to\cc-haha-main && skinny" -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path $CcHahaPath)) {
    Write-Host "[start] ERROR: cc-haha not found at '$CcHahaPath'" -ForegroundColor Red
    Write-Host "        Run: set CCHAHA_DIR=C:\path\to\cc-haha-main && skinny" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor DarkGray
Write-Host "  AI ready  |  phi4-mini / qwen + moondream + fetch MCP" -ForegroundColor White
Write-Host "  Change model: edit ANTHROPIC_MODEL in .env" -ForegroundColor DarkGray
Write-Host "======================================================" -ForegroundColor DarkGray
Write-Host ""

Set-Location $CcHahaPath
& bun --env-file=.env .\src\entrypoints\cli.tsx
