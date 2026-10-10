@echo off
chcp 65001 >nul
setlocal EnableExtensions
title CRM - Configuracao de Audio com IA
color 0B

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "ENV_FILE=%BACKEND%\.env"
set "ENV_EXAMPLE=%ROOT%.env.example"

echo =====================================================
echo   CRM COMERCIAL - CONFIGURAR AUDIO COM IA
echo =====================================================
echo.

echo [1/5] Verificando Node.js e npm...
where node >nul 2>nul
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado.
  echo Instale a versao LTS em https://nodejs.org/ e execute este BAT novamente.
  pause
  exit /b 1
)
for /f "delims=" %%V in ('node -v') do set "NODE_VERSION=%%V"
echo Node.js encontrado: %NODE_VERSION%
where npm >nul 2>nul
if errorlevel 1 (
  echo ERRO: npm nao encontrado. Reinstale o Node.js LTS.
  pause
  exit /b 1
)

echo.
echo [2/5] Preparando arquivo de configuracao...
if not exist "%ENV_FILE%" (
  if not exist "%ENV_EXAMPLE%" (
    echo ERRO: nao encontrei .env.example na pasta do projeto.
    echo.
    echo Verifique se o arquivo esta na raiz do projeto:
    echo %ROOT%.env.example
    echo.
    pause
    exit /b 1
  )
  copy "%ENV_EXAMPLE%" "%ENV_FILE%" >nul
  if errorlevel 1 (
    echo ERRO: nao foi possivel criar backend\.env.
    pause
    exit /b 1
  )
  echo Arquivo criado: backend\.env
) else (
  echo Arquivo existente sera preservado: backend\.env
  REM Garante que as linhas da ElevenLabs existam no arquivo atual
  findstr /i /b /c:"ELEVENLABS_API_KEY=" "%ENV_FILE%" >nul
  if errorlevel 1 (
    echo.
    echo Adicionando chaves ElevenLabs (ausentes) no backend\.env...
    echo.>>"%ENV_FILE%"
    echo.# Geracao de audio por IA no chat do CRM (ElevenLabs)>>"%ENV_FILE%"
    echo.# Configure a chave e o Voice ID no backend persistente; nunca no frontend.>>"%ENV_FILE%"
    echo.ELEVENLABS_API_KEY=>>"%ENV_FILE%"
    echo.ELEVENLABS_VOICE_ID=>>"%ENV_FILE%"
    echo.ELEVENLABS_MODEL_ID=eleven_multilingual_v2>>"%ENV_FILE%"
  )
)

echo.
echo [3/5] Abrindo configuracao para voce preencher...
echo.
echo No arquivo, preencha estas duas linhas com seus dados da ElevenLabs:
echo ELEVENLABS_API_KEY=sua_chave_real
echo ELEVENLABS_VOICE_ID=id_da_voz_escolhida
echo.
echo Nao compartilhe sua chave e nao a coloque no frontend.
echo Para obter os dados, acesse https://elevenlabs.io/ e consulte sua API key e Voice ID.
echo Salve o arquivo e feche o Bloco de Notas para continuar.
echo.
start /wait "" notepad "%ENV_FILE%"

echo.
echo [4/5] Validando configuracao da ElevenLabs...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%ENV_FILE%'; if (!(Test-Path $p)) { exit 2 }; $c=Get-Content -Raw $p; $k=[regex]::Match($c,'(?m)^\s*ELEVENLABS_API_KEY\s*=\s*(.+?)\s*$'); $v=[regex]::Match($c,'(?m)^\s*ELEVENLABS_VOICE_ID\s*=\s*(.+?)\s*$'); if (!$k.Success -or !$v.Success -or $k.Groups[1].Value -match 'sua_chave|^$' -or $v.Groups[1].Value -match 'id_da_voz|^$') { exit 1 }"
if errorlevel 1 (
  echo Nao consegui confirmar os dois valores no arquivo.
  echo Voce pode continuar, mas a geracao de audio nao funcionara ate preencher ELEVENLABS_API_KEY e ELEVENLABS_VOICE_ID.
  echo.
  setlocal EnableDelayedExpansion
  set /p "resp=Deseja abrir o arquivo novamente? [S/N] "
  if /i "!resp!"=="S" (
    start /wait "" notepad "%ENV_FILE%"
  )
  endlocal
)
echo Configuracao verificada (os valores nao serao exibidos).

:INICIAR
echo.
echo [5/5] Instalando dependencias e iniciando o CRM...
echo O script de inicializacao do projeto cuidara das dependencias do backend.
echo.
if not exist "%ROOT%run-crm.bat" (
  echo ERRO: run-crm.bat nao encontrado na pasta do projeto.
  pause
  exit /b 1
)
call "%ROOT%run-crm.bat"
exit /b %ERRORLEVEL%
