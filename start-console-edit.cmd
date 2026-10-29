@echo off
setlocal
cd /d "%~dp0"
echo Model Console editing mode. Changes require preview and Apply in the browser.
node src/server.mjs --enable-writes --open
if errorlevel 1 pause
