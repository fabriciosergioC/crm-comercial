@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Instalar a IA local do CRM
color 0B

:: ===================================================================
::  INSTALAR_IA_VOZ.bat
::  Baixa os motores oficiais (llama.cpp, whisper.cpp) e os
::  modelos (Qwen 1.5B e Whisper small) para tools\ai.
::  As ligações usam a voz do LiveKit Cloud, não precisam de Piper.
::
::  Pode rodar de novo sem medo: o que já existe é mantido.
::  Não altera o .env, o banco nem o CRM.
:: ===================================================================

cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo PowerShell nao encontrado neste Windows.
  pause
  exit /b 1
)

echo ============================================
echo    Instalar a IA local do CRM
echo ============================================
echo.
echo Serao baixados os programas e modelos necessarios (alguns GB).
echo Fontes oficiais: GitHub (llama.cpp, whisper.cpp) e
echo Hugging Face (Qwen e whisper.cpp).
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ai\install-ai.ps1" %*
set "CODIGO=%ERRORLEVEL%"

echo.
if not "%CODIGO%"=="0" (
  echo A instalacao nao terminou. Leia as mensagens acima.
) else (
  echo Agora use INICIAR_IA_VOZ.bat antes de abrir o CRM.
)
pause
exit /b %CODIGO%
