@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Reiniciar a API do CRM
color 0E

:: ===================================================================
::  REINICIAR_CRM.bat
::  Fecha a janela da API ("Backend CRM - API") e chama o run-crm.bat.
::
::  Para que serve: o backend roda o codigo que estava em disco no
::  momento em que a janela dele abriu. Qualquer mudanca feita nos
::  arquivos da pasta backend (por exemplo a senha que protege o
::  Excluir e o Desfazer do Financeiro) so comeca a valer depois de
::  fechar aquela janela e abrir de novo. Este atalho faz isso.
::
::  O que ele NAO faz: nao apaga, nao edita e nao mexe em nada do
::  Supabase. Vendas, leads, recebimentos e conversas ficam intactos.
::  Ele fecha somente o processo que esta na porta 3001 e a janela
::  preta que o abriu - e nada mais.
:: ===================================================================

set "SCRIPT_DIR=%~dp0"

echo ============================================
echo       Reiniciar a API do CRM
echo ============================================
echo.
echo Depois disto, na tela do CRM, segure CTRL e aperte F5 uma vez.
echo.

set "API_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr /C:":3001 "') do set "API_PID=%%p"

if not defined API_PID (
  echo Nada esta rodando na porta 3001 agora. Vou so abrir o CRM.
  echo.
  goto ABRIR
)

echo Vai fechar a janela da API, que hoje e o processo PID %API_PID%.
echo Nenhum dado e apagado: so o programa reinicia com o codigo novo.
echo.
choice /C SN /M "Fechar a API e abrir de novo agora"
if errorlevel 2 (
  echo.
  echo Nada foi fechado. Continue usando o CRM como esta.
  pause
  exit /b 1
)

echo.
echo Fechando a API...
powershell -NoProfile -Command "$n=(Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess; if(-not $n){ exit 0 }; $q=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $n); if($q.ParentProcessId){ $p=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $q.ParentProcessId); if($p.Name -eq 'cmd.exe'){ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }; Stop-Process -Id $n -Force -ErrorAction SilentlyContinue"
timeout /t 3 /nobreak >nul

:ABRIR
echo Abrindo o CRM de novo com o codigo atualizado...
echo.
call "%SCRIPT_DIR%run-crm.bat"
