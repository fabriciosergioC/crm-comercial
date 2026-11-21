@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Desligar os motores de IA de voz do CRM
color 0C

:: ===================================================================
::  PARAR_IA_VOZ.bat
::  Desliga somente o llama-server e o whisper-server iniciados por
::  INICIAR_IA_VOZ.bat (PIDs em tools\ai\run). O CRM e o WhatsApp
::  continuam intactos.
:: ===================================================================

cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell nao encontrado neste Windows.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ai\stop-ai.ps1" %*

echo.
pause
exit /b 0
