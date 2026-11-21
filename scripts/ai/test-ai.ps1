# ============================================================================
#  TESTE DE PONTA A PONTA DOS MOTORES LOCAIS DA IA (WhatsApp)
# ----------------------------------------------------------------------------
#  Verifica, sem alterar nada:
#    1. arquivos instalados (binários e modelos)
#    2. llama.cpp: /health + uma resposta real de chat
#    3. whisper.cpp: /health + transcrição de um WAV de 1 s
#    4. backend do CRM: /api/ai/status (llama, whisper, histórico e LiveKit)
#
#  Uso:
#    powershell -ExecutionPolicy Bypass -File scripts\ai\test-ai.ps1
#  Código de saída 0 = tudo que era possível testar passou.
# ============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AiHome = Join-Path $Root 'tools\ai'
$DirLlama = Join-Path $AiHome 'llama'
$DirWhisper = Join-Path $AiHome 'whisper'
$DirModels = Join-Path $AiHome 'models'

$LlamaPort = 8080
$WhisperPort = 8081
$CrmPort = 3001

$script:falhas = 0
$script:pulados = 0

function Write-Step([string]$Text) { Write-Host ''; Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "    !   $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "    X   $Text" -ForegroundColor Red; $script:falhas++ }
function Write-Skip([string]$Text) { Write-Host "    -   $Text" -ForegroundColor Gray; $script:pulados++ }

function Test-Health([string]$Url) {
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
  } catch { return $false }
}

function New-SilenceWav([string]$Path, [int]$Seconds) {
  $rate = 16000
  $samples = $rate * $Seconds
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $dataSize = $samples * 2
  $bw.Write([Text.Encoding]::ASCII.GetBytes('RIFF'))
  $bw.Write([int](36 + $dataSize))
  $bw.Write([Text.Encoding]::ASCII.GetBytes('WAVE'))
  $bw.Write([Text.Encoding]::ASCII.GetBytes('fmt '))
  $bw.Write([int]16)
  $bw.Write([int16]1)
  $bw.Write([int16]1)
  $bw.Write([int]$rate)
  $bw.Write([int]($rate * 2))
  $bw.Write([int16]2)
  $bw.Write([int16]16)
  $bw.Write([Text.Encoding]::ASCII.GetBytes('data'))
  $bw.Write([int]$dataSize)
  $rand = New-Object System.Random
  for ($i = 0; $i -lt $samples; $i++) { $bw.Write([int16]($rand.Next(-40, 40))) }
  $bw.Flush()
  [IO.File]::WriteAllBytes($Path, $ms.ToArray())
  $bw.Close()
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor White
Write-Host '  CRM Comercial  -  Teste dos motores locais da IA' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor White

# ---------------------------------------------------------------- arquivos
Write-Step 'Arquivos instalados'
$arquivos = @(
  @{ Path = (Join-Path $DirLlama 'llama-server.exe'); Label = 'llama-server.exe' },
  @{ Path = (Join-Path $DirWhisper 'whisper-server.exe'); Label = 'whisper-server.exe' },
  @{ Path = (Join-Path $DirModels 'qwen2.5-1.5b-instruct-q4_k_m.gguf'); Label = 'Qwen 1.5B (GGUF)' },
  @{ Path = (Join-Path $DirModels 'ggml-small.bin'); Label = 'Whisper small' }
)
foreach ($a in $arquivos) {
  if (Test-Path $a.Path) { Write-Ok $a.Label } else { Write-Fail "$($a.Label) ausente — rode INSTALAR_IA_VOZ.bat" }
}

# ---------------------------------------------------------------- llama.cpp
Write-Step "Conversa (llama.cpp) — http://127.0.0.1:$LlamaPort"
if (Test-Health "http://127.0.0.1:$LlamaPort/health") {
  Write-Ok '/health respondeu'
  try {
    $body = @{
      messages = @(
        @{ role = 'system'; content = 'Responda em português, no máximo 12 palavras.' },
        @{ role = 'user'; content = 'Diga apenas: teste de IA funcionando.' }
      )
      temperature = 0
      max_tokens = 24
      stream = $false
    } | ConvertTo-Json -Depth 6
    $inicio = Get-Date
    $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$LlamaPort/v1/chat/completions" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 180
    $ms = [math]::Round(((Get-Date) - $inicio).TotalMilliseconds)
    $texto = $resp.choices[0].message.content
    if ($texto) { Write-Ok "resposta em ${ms} ms: $($texto.Trim())" } else { Write-Fail 'a resposta veio vazia' }
  } catch {
    Write-Fail "falha na conversa: $($_.Exception.Message)"
  }
  try {
    $models = Invoke-RestMethod -Uri "http://127.0.0.1:$LlamaPort/v1/models" -TimeoutSec 10
    $ids = @($models.data | ForEach-Object { $_.id })
    if ($ids.Count) { Write-Ok "modelo carregado: $($ids -join ', ')" }
  } catch {}
} else {
  Write-Skip 'não está no ar — rode INICIAR_IA_VOZ.bat antes deste teste'
}

# ---------------------------------------------------------------- whisper.cpp
Write-Step "Transcrição (whisper.cpp) — http://127.0.0.1:$WhisperPort"
if (Test-Health "http://127.0.0.1:$WhisperPort/health") {
  Write-Ok '/health respondeu'
  $wav = Join-Path $env:TEMP ("crm-ai-teste-" + [guid]::NewGuid().ToString('N') + '.wav')
  try {
    New-SilenceWav $wav 1
    Add-Type -AssemblyName System.Net.Http
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds(180)
    $form = New-Object System.Net.Http.MultipartFormDataContent
    $bytes = [IO.File]::ReadAllBytes($wav)
    $fileContent = [System.Net.Http.ByteArrayContent]::new($bytes)
    $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('audio/wav')
    $form.Add($fileContent, 'file', 'teste.wav')
    $form.Add((New-Object System.Net.Http.StringContent('json')), 'response_format')
    $form.Add((New-Object System.Net.Http.StringContent('pt')), 'language')
    $inicio = Get-Date
    $resp = $client.PostAsync("http://127.0.0.1:$WhisperPort/inference", $form).Result
    $ms = [math]::Round(((Get-Date) - $inicio).TotalMilliseconds)
    $textoResposta = $resp.Content.ReadAsStringAsync().Result
    if ($resp.IsSuccessStatusCode) {
      Write-Ok "inferência respondeu em ${ms} ms (áudio de silêncio: texto vazio é o esperado)"
      Write-Host "      retorno: $($textoResposta.Trim())" -ForegroundColor DarkGray
    } else {
      Write-Fail "inferência falhou: HTTP $([int]$resp.StatusCode) — $textoResposta"
    }
    $client.Dispose()
    $form.Dispose()
  } catch {
    Write-Fail "falha na transcrição: $($_.Exception.Message)"
  } finally {
    if (Test-Path $wav) { Remove-Item $wav -Force -ErrorAction SilentlyContinue }
  }
} else {
  Write-Skip 'não está no ar — o assistente ainda funciona digitando a mensagem'
}

# ---------------------------------------------------------------- backend
Write-Step "Backend do CRM — http://127.0.0.1:$CrmPort/api/ai/status"
try {
  $st = Invoke-RestMethod -Uri "http://127.0.0.1:$CrmPort/api/ai/status" -TimeoutSec 15
  $dados = $st.data
  if (-not $dados) { $dados = $st }
  Write-Ok "IA: $($dados.llama.available) | transcrição: $($dados.whisper.available) | histórico: $($dados.storage.mode) | LiveKit: $($dados.livekit.configured)"
  if ($dados.storage.migrationPending) {
    Write-Warn 'migration 016 pendente: histórico em memória. Veja backend\AI_VOZ.md'
  }
} catch {
  Write-Skip 'backend não está rodando (abra run-crm.bat para testar a integração)'
}

# ---------------------------------------------------------------- resultado
Write-Host ''
if ($script:falhas -eq 0) {
  Write-Host 'Testes concluídos sem falhas.' -ForegroundColor Green
  if ($script:pulados -gt 0) { Write-Host "$($script:pulados) verificação(ões) pulada(s) porque o motor não estava no ar." -ForegroundColor Gray }
  Write-Host ''
  exit 0
}
Write-Host "$($script:falhas) falha(s). Leia as mensagens acima e backend\AI_VOZ.md." -ForegroundColor Red
Write-Host ''
exit 1
