# ============================================================
# Setup — esegui UNA SOLA VOLTA
# Aggiunge il comando `claude` al PATH e scarica i modelli
# ============================================================
$ErrorActionPreference = "Stop"
$ARCH_DIR = $PSScriptRoot

Write-Host ""
Write-Host "=== AI Architecture 8GB — Setup ===" -ForegroundColor Cyan
Write-Host ""

# ── 1. Variabili Ollama permanenti ────────────────────────────────────────────
Write-Host "[1/4] Imposto variabili Ollama..." -ForegroundColor Yellow
[System.Environment]::SetEnvironmentVariable("OLLAMA_MAX_LOADED_MODELS", "1", "User")
[System.Environment]::SetEnvironmentVariable("OLLAMA_NUM_PARALLEL",      "1", "User")
[System.Environment]::SetEnvironmentVariable("OLLAMA_KEEP_ALIVE",        "2m","User")
# Applica anche alla sessione corrente
$env:OLLAMA_MAX_LOADED_MODELS = "1"
$env:OLLAMA_NUM_PARALLEL      = "1"
$env:OLLAMA_KEEP_ALIVE        = "2m"
Write-Host "   OK" -ForegroundColor Green

# ── 2. Aggiungi ai-arch-8gb al PATH utente ───────────────────────────────────
Write-Host "[2/4] Aggiungo 'claude' al PATH..." -ForegroundColor Yellow
$currentPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if (-not $currentPath) { $currentPath = "" }
if ($currentPath -notlike "*$ARCH_DIR*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$currentPath;$ARCH_DIR", "User")
    $env:PATH = "$env:PATH;$ARCH_DIR"
    Write-Host "   Aggiunto: $ARCH_DIR" -ForegroundColor Green
} else {
    Write-Host "   Già presente nel PATH." -ForegroundColor DarkGray
}

# ── 3. Riavvia Ollama con le nuove variabili ──────────────────────────────────
Write-Host "[3/4] Riavvio Ollama..." -ForegroundColor Yellow
Stop-Process -Name "ollama" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
Start-Sleep -Seconds 4
Write-Host "   OK" -ForegroundColor Green

# ── 4. Scarica i modelli ─────────────────────────────────────────────────────
Write-Host "[4/4] Scarico modelli Ollama..." -ForegroundColor Yellow
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
Write-Host "   Modelli pronti." -ForegroundColor Green

# ── Fine ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Setup completato ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Apri un NUOVO terminale e digita:" -ForegroundColor White
Write-Host "  claude" -ForegroundColor Green
Write-Host ""
Write-Host "Oppure specifica dove hai cc-haha:" -ForegroundColor DarkGray
Write-Host "  set CCHAHA_DIR=C:\percorso\cc-haha-main && claude" -ForegroundColor DarkGray
Write-Host ""
