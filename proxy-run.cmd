@echo off
:loop
bun "%~dp0proxy.ts"
timeout /t 1 /nobreak >nul
goto loop
