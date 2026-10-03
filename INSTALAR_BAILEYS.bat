@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0backend"
where node >nul 2>nul || (echo Node.js nao encontrado. Instale Node.js 20+ e tente novamente.&pause&exit /b 1)
echo Instalando dependencias do CRM e Baileys...
npm install --no-fund --no-audit
if errorlevel 1 (echo Falha na instalacao.&pause&exit /b 1)
echo.
echo Baileys instalado. Agora configure backend\.env e execute run-crm.bat.
pause
