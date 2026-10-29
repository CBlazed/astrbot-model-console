@echo off
setlocal
cd /d "%~dp0"
node src/server.mjs --open
if errorlevel 1 pause
