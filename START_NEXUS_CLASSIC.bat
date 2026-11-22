@echo off
chcp 65001 >nul
title Nexus — klasicky server :8000
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_nexus.ps1" -Mode classic
