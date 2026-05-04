@echo off
:: ============================================================
:: skinny — local AI (phi4-mini + qwen + moondream)
:: Usage: skinny              → interactive session
::        skinny -p "prompt"  → headless mode
:: ============================================================
setlocal EnableDelayedExpansion

set "ARCH_DIR=%~dp0"
if "%ARCH_DIR:~-1%"=="\" set "ARCH_DIR=%ARCH_DIR:~0,-1%"

:: Path to cc-haha (parent folder by default)
if "%CCHAHA_DIR%"=="" set "CCHAHA_DIR=%ARCH_DIR%\..\cc-haha-main"

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

:: ── Start proxy if not already listening ─────────────────────────────────────
curl -s http://localhost:4000/health >nul 2>&1
if errorlevel 1 (
    echo [skinny] Starting proxy...
    start /b "" bun "%ARCH_DIR%\proxy.ts"
    timeout /t 3 /nobreak >nul
)

:: ── Start screen-watcher if not already running ──────────────────────────────
tasklist /fi "imagename eq bun.exe" /fo csv 2>nul | find "screen-watcher" >nul 2>&1
if errorlevel 1 (
    echo [skinny] Starting screen-watcher...
    start /b "" bun "%ARCH_DIR%\screen-watcher.ts"
)

:: ── Launch cc-haha ────────────────────────────────────────────────────────────
cd /d "%CCHAHA_DIR%"
bun --env-file=.env .\src\entrypoints\cli.tsx %*
