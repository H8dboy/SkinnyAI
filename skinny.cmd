@echo off
:: ============================================================
:: skinny — local AI (phi4-mini + qwen + moondream)
:: Usage: skinny              -> interactive session
::        skinny -p "prompt"  -> headless mode
:: ============================================================
setlocal EnableDelayedExpansion

set "ARCH_DIR=%~dp0"
if "%ARCH_DIR:~-1%"=="\" set "ARCH_DIR=%ARCH_DIR:~0,-1%"

:: Path to cc-haha — set CCHAHA_DIR env var to override
if "%CCHAHA_DIR%"=="" (
    echo [skinny] ERROR: CCHAHA_DIR is not set.
    echo         Run setup.ps1 or set: CCHAHA_DIR=C:\path\to\cc-haha-main
    exit /b 1
)

if not exist "%CCHAHA_DIR%" (
    echo [skinny] ERROR: cc-haha not found at %CCHAHA_DIR%
    exit /b 1
)

:: ── Write .mcp.json with absolute paths ──────────────────────────────────────
set "MCP_FILE=%CCHAHA_DIR%\.mcp.json"
set "VISION_PATH=%ARCH_DIR%\vision-mcp.ts"
set "VISION_JSON=%VISION_PATH:\=/%"

> "%MCP_FILE%" echo {
>> "%MCP_FILE%" echo   "mcpServers": {
>> "%MCP_FILE%" echo     "fetch": {
>> "%MCP_FILE%" echo       "command": "npx",
>> "%MCP_FILE%" echo       "args": ["-y", "@modelcontextprotocol/server-fetch"]
>> "%MCP_FILE%" echo     },
>> "%MCP_FILE%" echo     "vision": {
>> "%MCP_FILE%" echo       "command": "bun",
>> "%MCP_FILE%" echo       "args": ["%VISION_JSON%"]
>> "%MCP_FILE%" echo     }
>> "%MCP_FILE%" echo   }
>> "%MCP_FILE%" echo }

:: ── Build routing map on first run ──────────────────────────────────────────
if not exist "%ARCH_DIR%\routing\routing-config.json" (
    echo [skinny] First run: reading model DNA, please wait...
    bun "%ARCH_DIR%\dna-reader.ts"
)

:: ── Start proxy in its own hidden window ─────────────────────────────────────
curl -s http://localhost:4000/health >nul 2>&1
if errorlevel 1 (
    echo [skinny] Starting proxy...
    start "skinny-proxy" /min cmd /c "bun "%ARCH_DIR%\proxy.ts" >"%TEMP%\skinny-proxy.log" 2>&1"
    timeout /t 3 /nobreak >nul
)

:: ── Pre-warm phi4-mini (synchronous — cc-haha starts only after model is hot) ──
:: Only phi4-mini: with OLLAMA_MAX_LOADED_MODELS=1 loading qwen would evict it.
echo [skinny] Loading phi4-mini into RAM...
curl -s -X POST http://localhost:11434/api/generate ^
    -H "Content-Type: application/json" ^
    -d "{\"model\":\"phi4-mini\",\"prompt\":\"hi\",\"stream\":false,\"options\":{\"num_predict\":1}}" ^
    >nul 2>&1
echo [skinny] Model ready.

:: ── Start screen-watcher in its own hidden window ─────────────────────────────
tasklist /fi "imagename eq bun.exe" /fo csv 2>nul | find /i "screen-watcher" >nul 2>&1
if errorlevel 1 (
    echo [skinny] Starting screen-watcher...
    start "skinny-watcher" /min cmd /c "bun "%ARCH_DIR%\screen-watcher.ts" >"%TEMP%\skinny-watcher.log" 2>&1"
)

:: ── Launch cc-haha in this terminal (clean output for TUI) ───────────────────
echo [skinny] Starting...
echo.
cd /d "%CCHAHA_DIR%"
bun --env-file=.env .\src\entrypoints\cli.tsx %*
