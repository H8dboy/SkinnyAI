@echo off
:: ============================================================
:: skinny — local AI (qwen2.5-coder:1.5b + moondream on-demand)
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

:: ── Write .env (keeps model config in sync with arch) ────────────────────────
set "ENV_FILE=%CCHAHA_DIR%\.env"
> "%ENV_FILE%" echo ANTHROPIC_AUTH_TOKEN=sk-anything
>> "%ENV_FILE%" echo ANTHROPIC_BASE_URL=http://localhost:4000
>> "%ENV_FILE%" echo API_TIMEOUT_MS=3000000
>> "%ENV_FILE%" echo DISABLE_TELEMETRY=1
>> "%ENV_FILE%" echo CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
>> "%ENV_FILE%" echo ANTHROPIC_MODEL=qwen2.5-coder:1.5b
>> "%ENV_FILE%" echo ANTHROPIC_DEFAULT_SONNET_MODEL=qwen2.5-coder:1.5b
>> "%ENV_FILE%" echo ANTHROPIC_DEFAULT_HAIKU_MODEL=qwen2.5-coder:1.5b
>> "%ENV_FILE%" echo ANTHROPIC_DEFAULT_OPUS_MODEL=qwen2.5:7b-instruct-q3_K_M

:: ── Write .mcp.json with absolute paths ──────────────────────────────────────
set "MCP_FILE=%CCHAHA_DIR%\.mcp.json"
set "FETCH_PATH=%ARCH_DIR%\fetch-mcp.ts"
set "FETCH_JSON=%FETCH_PATH:\=/%"
set "VISION_PATH=%ARCH_DIR%\vision-mcp.ts"
set "VISION_JSON=%VISION_PATH:\=/%"

> "%MCP_FILE%" echo {
>> "%MCP_FILE%" echo   "mcpServers": {
>> "%MCP_FILE%" echo     "fetch": {
>> "%MCP_FILE%" echo       "command": "bun",
>> "%MCP_FILE%" echo       "args": ["%FETCH_JSON%"]
>> "%MCP_FILE%" echo     },
>> "%MCP_FILE%" echo     "vision": {
>> "%MCP_FILE%" echo       "command": "bun",
>> "%MCP_FILE%" echo       "args": ["%VISION_JSON%"]
>> "%MCP_FILE%" echo     }
>> "%MCP_FILE%" echo   }
>> "%MCP_FILE%" echo }

:: ── Kill whatever is on port 4000, start fresh proxy ────────────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":4000 "') do (
    taskkill /PID %%p /F >nul 2>&1
)
echo [skinny] Starting proxy...
start "skinny-proxy" /min cmd /c "bun "%ARCH_DIR%\proxy.ts" >> "%TEMP%\skinny-proxy.log" 2>&1"

:wait_proxy
curl -s http://localhost:4000/health >nul 2>&1
if errorlevel 1 ( timeout /t 1 /nobreak >nul & goto wait_proxy )
echo [skinny] Proxy ready.

:: ── Pre-warm qwen2.5-coder:1.5b in background (non-blocking) ────────────────
start /b powershell -WindowStyle Hidden -Command "Invoke-RestMethod -Uri http://localhost:11434/api/generate -Method Post -ContentType application/json -Body '{\"model\":\"qwen2.5-coder:1.5b\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1}}' -ErrorAction SilentlyContinue | Out-Null"

:: ── Launch cc-haha in this terminal (clean output for TUI) ───────────────────
echo [skinny] Starting...
echo.
cd /d "%CCHAHA_DIR%"
bun --env-file=.env .\src\entrypoints\cli.tsx %*
