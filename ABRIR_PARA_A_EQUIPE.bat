@echo off
chcp 65001 >nul
setlocal EnableExtensions
title CRM para a equipe - tunel ngrok
color 0B

:: ===================================================================
::  ABRE O CRM NA INTERNET PARA A EQUIPE (túnel ngrok)
::
::  O que este atalho faz:
::    1. Confere se o backend do CRM está de pé (run-crm.bat).
::    2. Confere se o ngrok está instalado neste computador.
::    3. Abre um túnel e mostra o endereço https://... que você manda
::       para as 1-3 pessoas da equipe.
::
::  O que você precisa saber (nada disso é secreto, é o plano grátis):
::    - O link só existe enquanto ESTA janela estiver aberta. Fechar a
::      janela (ou desligar o notebook) derruba o acesso na mesma hora.
::    - Sem o arquivo NGROK_URL.txt, o endereço muda toda vez que você
::      abrir esta janela. Com um endereço reservado grátis no site do
::      ngrok, ele nunca muda (veja HOSPEDAGEM.md).
::    - A equipe entra com a tela de senha do próprio CRM. Ninguém
::      precisa copiar token, chave ou instalar nada.
::    - Enquanto o túnel estiver aberto, quem tiver o link e a senha vê
::      os mesmos dados que você: leads, telefones e conversas.
::
::  Este atalho NÃO mexe no seu backend na porta 3001 e não fecha
::  nenhum programa seu.
:: ===================================================================

set "SCRIPT_DIR=%~dp0"
set "URL_FILE=%SCRIPT_DIR%NGROK_URL.txt"
set "HTTP_STATUS_FILE=%TEMP%\crm_tunel_http.txt"
set "PUBLIC_URL="

echo ========================================
echo     CRM PARA A EQUIPE - TUNEL NGROK
echo ========================================
echo.

:: -------------------------------------------------------------------
::  [1/4] O backend precisa estar rodando
:: -------------------------------------------------------------------
echo [1/4] Conferindo o backend do CRM em http://localhost:3001 ...
curl -s -o nul -w "%%{http_code}" http://localhost:3001/api/health > "%HTTP_STATUS_FILE%" 2>nul
set /p BACKEND_STATUS=<"%HTTP_STATUS_FILE%"
del "%HTTP_STATUS_FILE%" >nul 2>nul
if not "%BACKEND_STATUS%"=="200" goto SEM_BACKEND
echo       Backend respondendo HTTP %BACKEND_STATUS%. Ok.
echo.
goto CHECK_NGROK

:SEM_BACKEND
echo.
echo   O backend nao respondeu HTTP 200 em http://localhost:3001/api/health
echo   (status obtido: "%BACKEND_STATUS%").
echo   Abra o run-crm.bat primeiro, deixe a janela dele aberta, e entao
echo   abra este atalho de novo.
echo.
pause
exit /b 1

:: -------------------------------------------------------------------
::  [2/4] Ngrok instalado?
:: -------------------------------------------------------------------
:CHECK_NGROK
echo [2/4] Conferindo o ngrok...
where ngrok >nul 2>nul
if errorlevel 1 goto SEM_NGROK
echo       Ngrok encontrado. Ok.
echo.
goto CHECK_URL

:SEM_NGROK
echo.
echo   O ngrok nao esta no PATH deste computador.
echo   Instale com:  npm install -g ngrok
echo   Depois confirme sua conta em https://dashboard.ngrok.com e rode:
echo   ngrok config add-authtoken SEU_TOKEN_AQUI
echo.
pause
exit /b 1

:: -------------------------------------------------------------------
::  [3/4] Endereco fixo (opcional)
:: -------------------------------------------------------------------
:CHECK_URL
echo [3/4] Procurando um endereco reservado em NGROK_URL.txt...
if exist "%URL_FILE%" (
  set /p PUBLIC_URL=<"%URL_FILE%"
)
if defined PUBLIC_URL (
  echo       Usando o endereco fixo do arquivo: %PUBLIC_URL%
) else (
  echo       Arquivo nao encontrado: o ngrok vai sortear um endereco novo.
)
echo.

:: -------------------------------------------------------------------
::  [4/4] Abre o tunel
:: -------------------------------------------------------------------
echo [4/4] Abrindo o tunel para http://localhost:3001 ...
echo.
echo   ------------------------------------------------------------------------------
echo   Na proxima janela do ngrok procure a linha que comeca com  Forwarding
echo   Copie o endereco https:// ........................  ngrok  e mande para a equipe,
echo   junto com a senha que voce ja usa no CRM.
echo.
echo   Quer ver e copiar o link com conforto? Abra no navegador:
echo   http://localhost:4040
echo.
echo   Para DESLIGAR o acesso: feche esta janela (Ctrl+C tambem serve).
echo   O ngrok mostra uma pagina de aviso na primeira visita de cada
echo   endereco no plano gratis; a equipe clica em "Visit Site".
echo   ------------------------------------------------------------------------------
echo.

if defined PUBLIC_URL goto ABRIR_FIXO
ngrok http 3001
goto FIM

:ABRIR_FIXO
ngrok http 3001 --url=%PUBLIC_URL%

:FIM
echo.
echo Tunel encerrado. A equipe ja nao acessa mais o CRM.
pause
exit /b 0
