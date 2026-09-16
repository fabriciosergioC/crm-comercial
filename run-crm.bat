@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Sistema CRM - Inicializando...
color 0B

:: ===================================================================
::  Sistema CRM - Script de Inicialização Automatizada
::  1. Abre o frontend, que é autocontido: não precisa de servidor.
::  2. Sobe a API do backend em uma janela separada, quando disponível.
:: ===================================================================

set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%backend"
set "FRONTEND_DIR=%SCRIPT_DIR%frontend"
set "FRONTEND_FILE=%FRONTEND_DIR%\index.html"
set "INSTALL_LOG=%BACKEND_DIR%\install.log"
set "ENV_FILE=%BACKEND_DIR%\.env"
set "HTTP_STATUS_FILE=%TEMP%\crm_backend_http.txt"
set "NODE_OK=0"
set "BACKEND_READY=0"
set "BACKEND_STATUS="

echo ========================================
echo     Sistema CRM - Script de Inicialização
echo ========================================
echo.

:: -------------------------------------------------------------------
::  [1/6] Node.js
:: -------------------------------------------------------------------
echo 🔍 [1/6] Verificando o Node.js...
where node >nul 2>nul
if errorlevel 1 goto SEM_NODE
for /f "delims=" %%v in ('node --version 2^>nul') do echo ✅ Node.js encontrado: %%v
set "NODE_OK=1"
goto CHECK_FRONTEND

:SEM_NODE
echo ⚠️  Node.js não encontrado. O CRM abre normalmente sem ele.
echo     Apenas a API do backend ficará desativada.
goto CHECK_FRONTEND

:: -------------------------------------------------------------------
::  [2/6] Frontend
:: -------------------------------------------------------------------
:CHECK_FRONTEND
echo.
echo 🔍 [2/6] Verificando o frontend...
if not exist "%FRONTEND_FILE%" goto SEM_FRONTEND
echo ✅ Frontend encontrado: %FRONTEND_FILE%
goto CHECK_BACKEND

:SEM_FRONTEND
echo ❌ ERRO: arquivo não encontrado:
echo     %FRONTEND_FILE%
echo.
echo     Verifique se a pasta "frontend" está ao lado deste script.
echo.
pause
exit /b 1

:: -------------------------------------------------------------------
::  [3/6] Dependências do backend
:: -------------------------------------------------------------------
:CHECK_BACKEND
echo.
echo 🔍 [3/6] Verificando a API do backend - etapa opcional...
if "%NODE_OK%"=="0" goto BACKEND_PULADO
if not exist "%BACKEND_DIR%\server.js" goto BACKEND_PULADO
if not exist "%BACKEND_DIR%\routes" goto BACKEND_INCOMPLETO
if not exist "%BACKEND_DIR%\node_modules" goto INSTALAR_DEPS
echo ✅ Dependências do backend já instaladas.
goto CRIAR_ENV

:BACKEND_INCOMPLETO
echo ⚠️  API não iniciada: o módulo "backend\routes" ainda não existe.
echo     O CRM funciona normalmente sem ela - o frontend é autocontido.
goto BACKEND_PULADO

:INSTALAR_DEPS
echo 📦 Instalando as dependências do backend - primeira execução...
pushd "%BACKEND_DIR%"
call npm install --no-fund --no-audit > "%INSTALL_LOG%" 2>&1
if errorlevel 1 goto FALHA_INSTALL
popd
echo ✅ Dependências do backend instaladas.
goto CRIAR_ENV

:FALHA_INSTALL
popd
echo ⚠️  Falha ao instalar as dependências do backend. Veja o log:
echo     %INSTALL_LOG%
goto BACKEND_PULADO

:: -------------------------------------------------------------------
::  [4/6] Ambiente do backend - arquivo .env
:: -------------------------------------------------------------------
:CRIAR_ENV
set "BACKEND_READY=1"
echo.
echo ⚙️  [4/6] Configurando o ambiente do backend...
if exist "%ENV_FILE%" goto INICIAR_BACKEND
> "%ENV_FILE%" echo # Configurações do Backend CRM
>> "%ENV_FILE%" echo PORT=3001
>> "%ENV_FILE%" echo.
>> "%ENV_FILE%" echo # Credenciais do Supabase - https://app.supabase.io
>> "%ENV_FILE%" echo # Deixe preenchido para ativar os endpoints de dados.
>> "%ENV_FILE%" echo # Enquanto estiverem vazias as rotas de dados respondem 503.
>> "%ENV_FILE%" echo SUPABASE_URL=
>> "%ENV_FILE%" echo SUPABASE_SERVICE_ROLE_KEY=
>> "%ENV_FILE%" echo.
>> "%ENV_FILE%" echo CORS_ORIGIN=http://localhost:5500,http://127.0.0.1:5500,http://localhost:3000
echo ✅ Arquivo .env criado: %ENV_FILE%
goto INICIAR_BACKEND

:: -------------------------------------------------------------------
::  [5/6] API do backend
:: -------------------------------------------------------------------
:INICIAR_BACKEND
echo.
echo 🚀 [5/6] Iniciando a API do backend...
start "Backend CRM - API" /D "%BACKEND_DIR%" cmd /k node server.js
echo     API: http://localhost:3001/api - janela "Backend CRM - API".
echo     ⏳ Aguardando a API responder...
timeout /t 4 /nobreak >nul
curl -s -o nul -w "%%{http_code}" http://localhost:3001/api/health > "%HTTP_STATUS_FILE%" 2>nul
set /p BACKEND_STATUS=<"%HTTP_STATUS_FILE%"
del "%HTTP_STATUS_FILE%" >nul 2>nul
if "%BACKEND_STATUS%"=="200" echo ✅ API respondendo - HTTP 200.
if not "%BACKEND_STATUS%"=="200" echo ⚠️  API não respondeu HTTP 200 - status obtido: %BACKEND_STATUS%
goto ABRIR_FRONTEND

:BACKEND_PULADO
echo.
if "%BACKEND_READY%"=="0" echo ⚠️  Seguindo apenas com o frontend - a API não será iniciada.
goto ABRIR_FRONTEND

:: -------------------------------------------------------------------
::  [6/6] Frontend
:: -------------------------------------------------------------------
:ABRIR_FRONTEND
echo.
echo 🎨 [6/6] Abrindo o Sistema CRM no navegador...
start "" "%FRONTEND_FILE%"
if errorlevel 1 explorer "%FRONTEND_FILE%"
echo.
echo ========================================
echo       ✨ Sistema CRM - Pronto para Uso!
echo ========================================
echo.
echo 📋 Informações:
echo     Frontend: %FRONTEND_FILE%
if "%BACKEND_READY%"=="1" echo     Backend:  http://localhost:3001/api
if not "%BACKEND_READY%"=="1" echo     Backend:  não iniciado - o frontend é autocontido
echo.
if "%BACKEND_READY%"=="1" echo  Para encerrar: feche esta janela e a janela "Backend CRM - API".
if not "%BACKEND_READY%"=="1" echo  Para encerrar: feche esta janela.
echo.
echo     Pressione qualquer tecla para fechar este script...
pause >nul
exit /b 0