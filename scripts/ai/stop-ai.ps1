# ============================================================================
#  DESLIGA OS MOTORES LOCAIS DO ASSISTENTE DE VOZ
# ----------------------------------------------------------------------------
#  Usa os PIDs anotados por start-ai.ps1 em tools\ai\run. Se o arquivo sumiu,
#  só encerra processos cujo executável está DENTRO de tools\ai — nunca mata
#  outro llama-server/whisper-server que você tenha em outro projeto.
#
#  Uso:
#    powershell -ExecutionPolicy Bypass -File scripts\ai\stop-ai.ps1
#    (ou duplo clique em PARAR_IA_VOZ.bat)
# ============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AiHome = Join-Path $Root 'tools\ai'
$DirRun = Join-Path $AiHome 'run'

function Write-Ok([string]$Text) { Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "    !   $Text" -ForegroundColor Yellow }

function Stop-ByPidFile([string]$Name, [string]$PidFile) {
  if (-not (Test-Path $PidFile)) {
    Write-Warn "$Name : sem PID anotado (pode já estar desligado)."
    return
  }
  $pidValue = 0
  try { $pidValue = [int](Get-Content $PidFile -Raw).Trim() } catch { $pidValue = 0 }
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  if ($pidValue -le 0) { Write-Warn "$Name : PID inválido."; return }
  $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if (-not $proc) { Write-Ok "$Name já estava desligado (PID $pidValue)."; return }
  try {
    $path = $proc.Path
    if (-not $path -or -not $path.StartsWith($AiHome, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Warn "$Name : o PID $pidValue agora pertence a outro programa; não vou encerrá-lo."
      return
    }
  } catch {
    Write-Warn "$Name : não foi possível conferir o caminho do PID $pidValue; não vou encerrá-lo."
    return
  }
  try { Stop-Process -Id $pidValue -Force -ErrorAction Stop; Write-Ok "$Name desligado (PID $pidValue)." }
  catch { Write-Warn "$Name : não foi possível encerrar o PID $pidValue ($($_.Exception.Message))." }
}

function Stop-ByPath([string]$Name, [string]$ExeName) {
  $processos = @(Get-Process -Name $ExeName -ErrorAction SilentlyContinue)
  foreach ($p in $processos) {
    $path = ''
    try { $path = $p.Path } catch { $path = '' }
    if ($path -and $path.StartsWith($AiHome, [System.StringComparison]::OrdinalIgnoreCase)) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Write-Ok "$Name encerrado pelo caminho (PID $($p.Id))." } catch {}
    }
  }
}

Write-Host ''
Write-Host 'Desligando os motores de IA do CRM...' -ForegroundColor White
Stop-ByPidFile 'llama.cpp' (Join-Path $DirRun 'llama.pid')
Stop-ByPidFile 'whisper.cpp' (Join-Path $DirRun 'whisper.pid')
Stop-ByPath 'llama.cpp' 'llama-server'
Stop-ByPath 'whisper.cpp' 'whisper-server'
Write-Host ''
