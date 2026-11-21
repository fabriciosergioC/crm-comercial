# ============================================================================
#  SOBE OS MOTORES LOCAIS DO ASSISTENTE DE VOZ
# ----------------------------------------------------------------------------
#  - llama.cpp  (conversa)    127.0.0.1:8080
#  - whisper.cpp(transcrição) 127.0.0.1:8081
#
#  Regras:
#    - só escuta em 127.0.0.1 (nunca na rede pública/túnel)
#    - -ngl 0 / CPU, contexto 2048 e 4 threads (i5 + 8 GB)
#    - se o motor já estiver no ar, não sobe de novo
#    - PID e logs ficam em tools\ai\run e tools\ai\logs
#    - o script termina; os motores ficam rodando em segundo plano
#
#  Uso:
#    powershell -ExecutionPolicy Bypass -File scripts\ai\start-ai.ps1
#    (ou duplo clique em INICIAR_IA_VOZ.bat)
#
#  Opções:
#    -NoLlama     não sobe a conversa
#    -NoWhisper   não sobe a transcrição
#    -WaitReady   só termina depois que os motores responderem (até 3 min)
# ============================================================================

[CmdletBinding()]
param(
  [switch]$NoLlama,
  [switch]$NoWhisper,
  [switch]$WaitReady
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AiHome = Join-Path $Root 'tools\ai'
$DirLlama = Join-Path $AiHome 'llama'
$DirWhisper = Join-Path $AiHome 'whisper'
$DirModels = Join-Path $AiHome 'models'
$DirLogs = Join-Path $AiHome 'logs'
$DirRun = Join-Path $AiHome 'run'

$LlamaExe = Join-Path $DirLlama 'llama-server.exe'
$WhisperExe = Join-Path $DirWhisper 'whisper-server.exe'
$LlamaModel = Join-Path $DirModels 'qwen2.5-1.5b-instruct-q4_k_m.gguf'
$WhisperModel = Join-Path $DirModels 'ggml-small.bin'
$LlamaPort = 8080
$WhisperPort = 8081

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "    !   $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "    X   $Text" -ForegroundColor Red }

foreach ($dir in @($AiHome, $DirLogs, $DirRun)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false } finally { $client.Close() }
}

function Test-Health([string]$Url) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch { return $false }
}

function Wait-Health([string]$Url, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-Health $Url) { return $true }
    Start-Sleep -Milliseconds 800
  }
  return $false
}

function Read-Pid([string]$File) {
  if (-not (Test-Path $File)) { return 0 }
  try { return [int](Get-Content $File -Raw).Trim() } catch { return 0 }
}

function Stop-Old([string]$PidFile, [string]$ExePath) {
  $oldPid = Read-Pid $PidFile
  if ($oldPid -le 0) { return }
  $proc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
  if (-not $proc) { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue; return }
  try {
    $path = $proc.Path
    if ($path -and ($path -ne $ExePath)) { return }  # PID reciclado: não mata outro programa
  } catch { return }
  Write-Warn "encerrando instância antiga (PID $oldPid)..."
  Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 600
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Start-Engine([string]$Name, [string]$Exe, [string]$WorkDir, [string[]]$Arguments, [string]$PidFile, [string]$LogBase, [string]$HealthUrl) {
  if (-not (Test-Path $Exe)) {
    Write-Fail "$Name não instalado. Rode INSTALAR_IA_VOZ.bat primeiro."
    return $false
  }
  $stdout = "$LogBase.out.log"
  $stderr = "$LogBase.err.log"
  try {
    $proc = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $WorkDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  } catch {
    Write-Fail "não foi possível iniciar ${Name}: $($_.Exception.Message)"
    return $false
  }
  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII
  Write-Ok "$Name iniciado (PID $($proc.Id))"
  Write-Host "      log: $stderr"

  if ($WaitReady) {
    Write-Host '      aguardando carregar o modelo (pode levar até 2 min nesta CPU)...'
    if (Wait-Health $HealthUrl 180) {
      Write-Ok "$Name respondendo"
      return $true
    }
    Write-Fail "$Name não respondeu em 3 min. Veja o log: $stderr"
    return $false
  }
  return $true
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor White
Write-Host '  CRM Comercial  -  Motores de IA de voz' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor White

$resultado = 0

# ---------------------------------------------------------------- llama.cpp
if (-not $NoLlama) {
  Write-Step "Conversa (llama.cpp) em http://127.0.0.1:$LlamaPort"
  if (Test-Port $LlamaPort) {
    if (Test-Health "http://127.0.0.1:$LlamaPort/health") {
      Write-Ok 'já está no ar; nada a fazer'
    } else {
      Write-Warn "a porta $LlamaPort está ocupada por outro processo. Feche-o ou mude LLAMA_BASE_URL no .env."
      $resultado = 1
    }
  } elseif (-not (Test-Path $LlamaModel)) {
    Write-Fail "modelo ausente: $LlamaModel"
    Write-Fail 'Rode INSTALAR_IA_VOZ.bat para baixar o Qwen 1.5B.'
    $resultado = 1
  } else {
    Stop-Old (Join-Path $DirRun 'llama.pid') $LlamaExe
    $engineArgs = @(
      '-m', "`"$LlamaModel`"",
      '-ngl', '0',
      '-c', '2048',
      '-t', '4',
      '--host', '127.0.0.1',
      '--port', "$LlamaPort",
      '--alias', 'qwen2.5-1.5b-instruct'
    )
    if (-not (Start-Engine 'llama.cpp' $LlamaExe $DirLlama $engineArgs (Join-Path $DirRun 'llama.pid') (Join-Path $DirLogs 'llama') "http://127.0.0.1:$LlamaPort/health")) { $resultado = 1 }
  }
}

# ---------------------------------------------------------------- whisper.cpp
if (-not $NoWhisper) {
  Write-Step "Transcrição (whisper.cpp) em http://127.0.0.1:$WhisperPort"
  if (Test-Port $WhisperPort) {
    if (Test-Health "http://127.0.0.1:$WhisperPort/health") {
      Write-Ok 'já está no ar; nada a fazer'
    } else {
      Write-Warn "a porta $WhisperPort está ocupada por outro processo. Feche-o ou mude WHISPER_BASE_URL no .env."
      $resultado = 1
    }
  } elseif (-not (Test-Path $WhisperModel)) {
    Write-Fail "modelo ausente: $WhisperModel"
    Write-Fail 'Rode INSTALAR_IA_VOZ.bat para baixar o ggml-small.bin.'
    $resultado = 1
  } else {
    Stop-Old (Join-Path $DirRun 'whisper.pid') $WhisperExe
    $engineArgs = @(
      '-m', "`"$WhisperModel`"",
      '-l', 'pt',
      '-t', '4',
      '--host', '127.0.0.1',
      '--port', "$WhisperPort"
    )
    if (-not (Start-Engine 'whisper.cpp' $WhisperExe $DirWhisper $engineArgs (Join-Path $DirRun 'whisper.pid') (Join-Path $DirLogs 'whisper') "http://127.0.0.1:$WhisperPort/health")) { $resultado = 1 }
  }
}

Write-Host ''
if ($resultado -eq 0) {
  Write-Host 'Motores no ar. Abra o CRM e use a aba "IA por voz" no detalhe do lead.' -ForegroundColor Green
  Write-Host 'Para verificar de ponta a ponta: test-ai.ps1' -ForegroundColor Gray
  Write-Host 'Para desligar: PARAR_IA_VOZ.bat' -ForegroundColor Gray
} else {
  Write-Host 'Um ou mais motores não subiram. Leia as mensagens acima.' -ForegroundColor Yellow
  Write-Host 'Logs: tools\ai\logs' -ForegroundColor Gray
}
Write-Host ''

if ($resultado -ne 0) { exit 1 }
