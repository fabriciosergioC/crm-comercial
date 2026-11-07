@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Backup do banco do CRM
color 0A

:: ===================================================================
::  BACKUP_BANCO.bat
::  Copia o banco do Supabase para a pasta backups\supabase do projeto.
::
::  Para que serve: guardar uma foto de tudo (leads, clientes, financeiro,
::  conversas de WhatsApp e usuarios) num dia e hora, sem instalar nada e
::  sem usar o pg_dump. O script le a SUPABASE_URL e a service_role key do
::  backend\.env, entao voce nao digita credencial nenhuma.
::
::  Para onde vai: backups\supabase\<data-hora>\ com um arquivo .json por
::  tabela e um manifest.json dizendo quantas linhas cada uma tem. Como a
::  pasta esta dentro de Documentos, o OneDrive sobe sozinho. Ela esta no
::  .gitignore, entao os dados dos clientes nunca vao para o GitHub.
::
::  O que ele NAO faz: nao apaga e nao escreve nada no banco. Le somente.
::  A unica forma de gravar de volta e rodando voce mesmo, no terminal:
::     node scripts\backup-supabase.js --restaurar backups\supabase\<pasta>
::  e, mesmo assim, ele pede a palavra RESTAURAR antes de limpar algo.
:: ===================================================================

set "SCRIPT_DIR=%~dp0"

echo ============================================
echo       Backup do banco (Supabase)
echo ============================================
echo.
echo Nada e apagado no banco: este arquivo so copia para o seu disco.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node nao esta no PATH desta janela. Abra o run-crm.bat primeiro,
  echo que ele usa o Node que ja funciona, e rode este atalho de novo.
  echo.
  pause
  exit /b 1
)

node "%SCRIPT_DIR%scripts\backup-supabase.js"
if errorlevel 1 (
  echo.
  echo O backup nao terminou. Leia a linha "Backup falhou" acima:
  echo   - ENOTFOUND / NODENAMEERROS  = o backend\.env aponta para um projeto
  echo     que nao existe (mesmo erro que derrubou o CRM);
  echo   - sem chave no .env          = rode primeiro o backend\.env.example.
  echo.
  pause
  exit /b 1
)

echo.
choice /C SN /M "Abrir a pasta dos backups no Explorador"
if errorlevel 2 goto FIM
start "" explorer "%SCRIPT_DIR%backups\supabase"

:FIM
echo.
pause
