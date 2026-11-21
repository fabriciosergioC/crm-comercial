@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Motores de IA local do CRM
color 0A

:: ===================================================================
::  INICIAR_IA_VOZ.bat
::  Sobe o llama.cpp (conversa, 127.0.0.1:8080) e o whisper.cpp
::  (transcricao, 127.0.0.1:8081) em segundo plano com os logs em
::  tools\ai\logs. Pode rodar de novo: o que ja estiver no ar e
::  mantido. Nada e exposto na rede - so o proprio notebook acessa.
:: ===================================================================

cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell nao encontrado neste Windows.
  pause
  exit /b 1
)

echo ============================================
echo    Motores de IA local do CRM (texto e audio)
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ai\start-ai.ps1" -WaitReady %*
set "CODIGO=%ERRORLEVEL%"

echo.
if not "%CODIGO%"=="0" (
  echo Um ou mais motores nao subiram. Veja tools\ai\logs.
) else (
  echo Pode deixar esta janela fechar. Abra o CRM com run-crm.bat.
)
pause
exit /b %CODIGO%
