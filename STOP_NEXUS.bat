@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_nexus.ps1"
if errorlevel 1 exit /b 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_filester.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop_searxng.ps1"
