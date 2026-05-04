# ============================================================
# AI Architecture 8GB RAM — Script di avvio
# Avvia: Ollama (ottimizzato) + proxy + screen-watcher + cc-haha
# ============================================================
param(
    [string]$CcHahaPath = "$PSScriptRoot\..\cc-haha-main"
)

$ErrorActionPreference = "Stop"
$ROOT = $PSScriptRoot

# ── 1. Variabili Ollama — un solo modello in RAM alla volta ───────────────────
$env:OLLAMA_MAX_LOADED_MODELS = "1"   # swap automatico, mai due modelli insieme
$env:OLLAMA_NUM_PARALLEL      = "1"   # una richiesta alla volta → no contesa RAM
$env:OLLAMA_KEEP_ALIVE        = "2m"  # scarica il modello dopo 2 min di inattività

# ── 2. Riavvia Ollama con le nuove variabili ──────────────────────────────────
Write-Host "[start] Riavvio Ollama con impostazioni ottimizzate..." -ForegroundColor Cyan
$ollamaProc = Get-Process -Name "ollama" -ErrorAction SilentlyContinue
if ($ollamaProc) {
    Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 3

# Verifica che Ollama risponda
try {
    $null = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -TimeoutSec 10
    Write-Host "[start] Ollama pronto." -ForegroundColor Green
} catch {
    Write-Host "[start] ERRORE: Ollama non risponde. Assicurati che sia installato." -ForegroundColor Red
    exit 1
}

# ── 3. Pull modelli se non presenti ───────────────────────────────────────────
$models = (Invoke-RestMethod -Uri "http://localhost:11434/api/tags").models.name
if (-not ($models -like "*phi4-mini*")) {
    Write-Host "[start] Download phi4-mini (~2.5 GB, prima volta)..." -ForegroundColor Yellow
    & ollama pull phi4-mini
}
if (-not ($models -like "*qwen2.5-coder*")) {
    Write-Host "[start] Download qwen2.5-coder:1.5b (~1 GB, prima volta)..." -ForegroundColor Yellow
    & ollama pull qwen2.5-coder:1.5b
}
if (-not ($models -like "*moondream*")) {
    Write-Host "[start] Download moondream (~1.7 GB, prima volta)..." -ForegroundColor Yellow
    & ollama pull moondream
}

# ── 4. Proxy (background) ─────────────────────────────────────────────────────
Write-Host "[start] Avvio proxy Anthropic→Ollama..." -ForegroundColor Cyan
Start-Process -FilePath "bun" -ArgumentList "proxy.ts" -WorkingDirectory $ROOT -WindowStyle Hidden

Start-Sleep -Seconds 2
try {
    $health = Invoke-RestMethod -Uri "http://localhost:4000/health" -TimeoutSec 5
    Write-Host "[start] Proxy ok — modello: $($health.model)" -ForegroundColor Green
} catch {
    Write-Host "[start] ATTENZIONE: proxy non risponde." -ForegroundColor Yellow
}

# ── 5. Screen watcher (background) ───────────────────────────────────────────
Write-Host "[start] Avvio screen watcher..." -ForegroundColor Cyan
Start-Process -FilePath "bun" -ArgumentList "screen-watcher.ts" -WorkingDirectory $ROOT -WindowStyle Hidden
Write-Host "[start] Screen watcher avviato in background." -ForegroundColor Green

# ── 6. cc-haha (foreground) ──────────────────────────────────────────────────
if (-not (Test-Path $CcHahaPath)) {
    Write-Host "[start] ERRORE: cc-haha non trovato in '$CcHahaPath'" -ForegroundColor Red
    Write-Host "        Usa: .\start.ps1 -CcHahaPath 'C:\percorso\cc-haha-main'" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "======================================================" -ForegroundColor DarkGray
Write-Host "  AI pronta  |  phi4-mini / qwen + moondream + fetch MCP" -ForegroundColor White
Write-Host "  Cambia modello: modifica ANTHROPIC_MODEL in .env" -ForegroundColor DarkGray
Write-Host "======================================================" -ForegroundColor DarkGray
Write-Host ""

Set-Location $CcHahaPath
& bun --env-file=.env .\src\entrypoints\cli.tsx
