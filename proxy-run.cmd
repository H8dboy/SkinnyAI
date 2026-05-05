@echo off
:loop
bun "%~dp0proxy.ts" > "%TEMP%\skinny-proxy.log" 2>&1
timeout /t 1 /nobreak >nul
goto loop
