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
    pause & exit /b 1
)

if not exist "%CCHAHA_DIR%" (
    echo [skinny] ERROR: cc-haha not found at %CCHAHA_DIR%
    pause & exit /b 1
)

:: ── Write .env ────────────────────────────────────────────────────────────────
set "ENV_FILE=%CCHAHA_DIR%\.env"
> "%ENV_FILE%" echo ANTHROPIC_AUTH_TOKEN=sk-anything
>> "%ENV_FILE%" echo ANTHROPIC_BASE_URL=http://localhost:4000
>> "%ENV_FILE%" echo API_TIMEOUT_MS=3000000
>> "%ENV_FILE%" echo DISABLE_TELEMETRY=1
>> "%ENV_FILE%" echo CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
>> "%ENV_FILE%" echo ANTHROPIC_MODEL=qwen2.5-coder:0.5b
>> "%ENV_FILE%" echo ANTHROPIC_DEFAULT_SONNET_MODEL=qwen2.5-coder:1.5b
>> "%ENV_FILE%" echo ANTHROPIC_DEFAULT_HAIKU_MODEL=smollm2:135m
>> "%ENV_FILE%" echo ANTHROPIC_DEFAULT_OPUS_MODEL=qwen2.5-coder:1.5b

:: ── Write .mcp.json ───────────────────────────────────────────────────────────
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

:: ── Kill old proxy, start fresh ───────────────────────────────────────────────
for /f "tokens=5" %%p in ('netstat -ano 2^>nul ^| findstr ":4000 "') do (
    taskkill /PID %%p /F >nul 2>&1
)

set "OLLAMA_MODEL=qwen2.5-coder:1.5b"
echo [skinny] Starting proxy...
start "skinny-proxy" /min "%ARCH_DIR%\proxy-run.cmd"

:wait_proxy
curl -s http://localhost:4000/health >nul 2>&1
if not errorlevel 1 goto proxy_ready
timeout /t 1 /nobreak >nul
goto wait_proxy

:proxy_ready
echo [skinny] Proxy ready.

:: ── Pre-warm all 3 models into RAM with correct ctx ──────────────────────────
echo [skinny] Loading models into RAM...
curl -s -X POST http://localhost:11434/api/generate -H "Content-Type: application/json" -d "{\"model\":\"smollm2:135m\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1,\"num_ctx\":256}}" > nul
curl -s -X POST http://localhost:11434/api/generate -H "Content-Type: application/json" -d "{\"model\":\"qwen2.5-coder:0.5b\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1,\"num_ctx\":512}}" > nul
curl -s -X POST http://localhost:11434/api/generate -H "Content-Type: application/json" -d "{\"model\":\"qwen2.5-coder:1.5b\",\"prompt\":\"hi\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_predict\":1,\"num_ctx\":512}}" > nul
echo [skinny] Models ready.

:: ── Launch cc-haha ────────────────────────────────────────────────────────────
echo [skinny] Starting...
echo.
cd /d "%CCHAHA_DIR%"
bun --env-file=.env .\src\entrypoints\cli.tsx %*
