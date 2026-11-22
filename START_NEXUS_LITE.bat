@echo off
chcp 65001 >nul
title Nexus LITE — Ingest Server ^& Live Gallery :8000
cls

echo ================================================================
echo           ⚡ NEXUS LITE — INGEST SERVER ^& GALLERY HUB ⚡
echo ================================================================
echo.
echo  [+] Startujem ultra-lahky Nexus LITE server...
echo  [+] Inicializujem API pre userscripty a live dashboard...
echo.

cd /d "%~dp0"
echo  [*] Vyberam dostupny Python a otvaram dashboard na porte 8000...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_nexus.ps1" -Mode lite

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] Doslo k chybe pri spusteni servera.
    echo Stlac lubovolnu klavesu pre ukoncenie...
    pause >nul
)
