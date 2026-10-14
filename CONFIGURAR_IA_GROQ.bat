@echo off
setlocal EnableExtensions
title CRM - Configurar IA de respostas (Groq)
color 0B

set "ROOT=%~dp0"
set "ENV_FILE=%ROOT%backend\.env"
set "ENV_EXAMPLE=%ROOT%.env.example"

echo =====================================================
echo   CRM COMERCIAL - CONFIGURAR IA DE RESPOSTAS (GROQ)
echo =====================================================
echo.
echo Voce precisa ter criado a chave gratuita em https://console.groq.com
echo (login com sua conta Google, menu "API Keys", botao Create API Key).
echo.
echo [1/4] Verificando os arquivos...
if not exist "%ENV_FILE%" (
  if not exist "%ENV_EXAMPLE%" (
    echo ERRO: nao encontrei nem backend\.env nem .env.example nesta pasta:
    echo %ROOT%
    pause
    exit /b 1
  )
  copy "%ENV_EXAMPLE%" "%ENV_FILE%" >nul
  echo Criei o arquivo backend\.env a partir do modelo.
) else (
  echo Arquivo encontrado: backend\.env
)
echo.
node -e "const fs=require('fs');process.exit(/GROQ_API_KEY[ ]*=/.test(fs.readFileSync(process.env.ENV_FILE,'utf8')) ? 0 : 1)"
if not errorlevel 1 goto :linhas_presentes
echo Acrescentando as linhas da Groq, que ainda nao estavam no arquivo...
>>"%ENV_FILE%" echo.
>>"%ENV_FILE%" echo.# Sugestoes de resposta por IA no chat (Groq)
>>"%ENV_FILE%" echo.GROQ_API_KEY=
>>"%ENV_FILE%" echo.GROQ_MODEL=openai/gpt-oss-120b
>>"%ENV_FILE%" echo.IA_SUGESTOES_QUANTIDADE=3
:linhas_presentes


echo.
echo [2/4] Vai abrir o Bloco de Notas com o arquivo de configuracao.
echo.
echo   Procure a linha GROQ_API_KEY= e cole a SUA chave depois do igual:
echo       GROQ_API_KEY=gsk_SUA_CHAVE_AQUI
echo.
echo   Sem espaco depois do igual, sem aspas, e sem mandar a chave para ninguem.
echo.
echo   Se o Bloco de Notas NAO aparecer, ele esta atras desta janela -
echo   veja a barra de tarefas. O arquivo e este, se preferir abrir na mao:
echo       %ENV_FILE%
echo.
if not exist "%SystemRoot%\System32\notepad.exe" (
  echo ERRO: este Windows nao tem o Bloco de Notas. Abra o arquivo acima em
  echo qualquer editor de texto, salve e rode este BAT de novo.
  pause
  exit /b 1
)
echo Pressione uma tecla para o Bloco de Notas abrir.
pause
start "" /wait notepad "%ENV_FILE%"

echo.
echo [3/4] Conferindo o arquivo (o valor da chave nao aparece aqui)...
node -e "const fs=require('fs');const c=fs.readFileSync(process.env.ENV_FILE,'utf8');const m=c.match(/^GROQ_API_KEY[ ]*=[ ]*([^ \t\r\n]+)/m);process.exit(m && /^gsk_/.test(m[1]) ? 0 : 1)"
if not errorlevel 1 goto :chave_ok
echo Nao encontrei uma chave valida: o valor precisa comecar com gsk_,
echo exatamente como aparece no site da Groq.
set /p "resp=Abrir o arquivo de novo para corrigir? [S/N] "
if /i not "%resp%"=="S" goto :sem_chave
start "" /wait notepad "%ENV_FILE%"
node -e "const fs=require('fs');const c=fs.readFileSync(process.env.ENV_FILE,'utf8');const m=c.match(/^GROQ_API_KEY[ ]*=[ ]*([^ \t\r\n]+)/m);process.exit(m && /^gsk_/.test(m[1]) ? 0 : 1)"
if not errorlevel 1 goto :chave_ok

:sem_chave
echo.
echo A IA nao vai funcionar ate a chave estar certa no arquivo.
echo O botao do chat mostra o aviso com estes mesmos passos quando falhar.
goto :iniciar

:chave_ok
echo Chave reconhecida.

:iniciar
echo.
echo [4/4] A IA so funciona depois de reiniciar o backend...
node -e "fetch('http://127.0.0.1:3001/api/health').then(function(r){process.exit(r.ok?0:1)},function(){process.exit(1)})"
if not errorlevel 1 goto :backend_aberto
echo O backend nao esta rodando - iniciando o CRM agora.
if not exist "%ROOT%run-crm.bat" (
  echo ERRO: run-crm.bat nao encontrado nesta pasta: %ROOT%
  pause
  exit /b 1
)
call "%ROOT%run-crm.bat"
exit /b %ERRORLEVEL%

:backend_aberto
echo O backend atual foi aberto ANTES da IA existir no projeto, e ele continua
echo de posse da porta 3001. Para a rota nova funcionar:
echo   1) feche a janela preta chamada "Backend CRM - API"
echo   2) de dois cliques em run-crm.bat
echo Nao rode o run-crm.bat com ele ainda aberto: a porta 3001 estaria ocupada.
pause
exit /b 0
