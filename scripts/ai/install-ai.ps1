# ============================================================================
#  INSTALADOR DA IA LOCAL DO CRM (WhatsApp)
# ----------------------------------------------------------------------------
#  Baixa SOMENTE componentes oficiais:
#    - llama.cpp  -> github.com/ggml-org/llama.cpp  (release CPU x64)
#    - whisper.cpp-> github.com/ggml-org/whisper.cpp (release x64)
#    - Modelos    -> huggingface.co (Qwen, ggerganov/whisper.cpp)
#    (a voz local/Piper foi removida; ligações usam o LiveKit Cloud)
#
#  Seguro e idempotente:
#    - nada é apagado; o que já existe é mantido (use -Force para rebaixar)
#    - nenhum executável de fonte desconhecida
#    - nenhuma alteração no banco, no .env ou nas configurações existentes
#
#  Uso:
#    powershell -ExecutionPolicy Bypass -File scripts\ai\install-ai.ps1
#    (ou dê um duplo clique em INSTALAR_IA_VOZ.bat)
#
#  Opções:
#    -Force          rebaixa o que já existe
#    -SkipLlama      não baixa o llama.cpp
#    -SkipWhisper    não baixa o whisper.cpp
#    -SkipModels     não baixa os modelos (GGUF/bin)
#    -WhisperModel   ggml-small.bin (padrão) | ggml-base.bin (mais leve)
# ============================================================================

[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$SkipLlama,
  [switch]$SkipWhisper,
  [switch]$SkipModels,
  [ValidateSet('ggml-small.bin', 'ggml-base.bin')]
  [string]$WhisperModel = 'ggml-small.bin'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$AiHome = Join-Path $Root 'tools\ai'
$DirLlama = Join-Path $AiHome 'llama'
$DirWhisper = Join-Path $AiHome 'whisper'
$DirModels = Join-Path $AiHome 'models'
$DirDownloads = Join-Path $AiHome 'downloads'
$DirLogs = Join-Path $AiHome 'logs'
$DirRun = Join-Path $AiHome 'run'

$QwenFile = 'qwen2.5-1.5b-instruct-q4_k_m.gguf'

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) { Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "    !   $Text" -ForegroundColor Yellow }
function Write-Fail([string]$Text) { Write-Host "    X   $Text" -ForegroundColor Red }

function Download-File([string]$Url, [string]$Dest) {
  if ((Test-Path $Dest) -and -not $Force) {
    Write-Ok "já existe: $(Split-Path -Leaf $Dest)"
    return
  }
  $tmp = "$Dest.part"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  Write-Host "    baixando $(Split-Path -Leaf $Dest) ..."
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 --silent --show-error -o $tmp $Url
    if ($LASTEXITCODE -ne 0) { throw "Download falhou (curl $LASTEXITCODE): $Url" }
  } else {
    Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -TimeoutSec 1800 -Headers @{ 'User-Agent' = 'crm-comercial-installer' }
  }
  if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -lt 1024) { throw "Download vazio ou incompleto: $Url" }
  Move-Item $tmp $Dest -Force
  Write-Ok "$(Split-Path -Leaf $Dest) ($([math]::Round((Get-Item $Dest).Length / 1MB, 1)) MB)"
}

# Procura, nos últimos releases oficiais do repositório, o primeiro asset cujo
# nome casa com o padrão. Assim o link não fica preso a um build antigo.
function Find-GithubAsset([string]$Repo, [string]$Pattern) {
  $headers = @{ 'User-Agent' = 'crm-comercial-installer'; 'Accept' = 'application/vnd.github+json' }
  $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases?per_page=15" -Headers $headers -TimeoutSec 30
  foreach ($rel in @($releases)) {
    $asset = @($rel.assets) | Where-Object { $_.name -match $Pattern } | Select-Object -First 1
    if ($asset) {
      return [pscustomobject]@{ Tag = $rel.tag_name; Name = $asset.name; Url = $asset.browser_download_url }
    }
    if ($rel.tag_name -ne 'v1.0.0') { Write-Host "      (release $($rel.tag_name) sem pacote Windows compatível)" -ForegroundColor DarkGray }
  }
  throw "Nenhum release de $Repo com pacote /$Pattern/ encontrado."
}

# Extrai o zip e copia o conteúdo da pasta que contém o executável (o layout do
# zip muda de versão para versão: às vezes os arquivos ficam na raiz, às vezes
# dentro de uma pasta com o nome do build).
function Expand-ZipAsset([string]$Zip, [string]$Dest, [string]$ExeName) {
  $tmp = Join-Path $env:TEMP ("crm-ai-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Expand-Archive -Path $Zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem -Path $tmp -Filter $ExeName -Recurse -File | Select-Object -First 1
    if (-not $exe) { throw "O pacote não contém $ExeName." }
    $source = $exe.Directory.FullName
    if (-not (Test-Path $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }
    Copy-Item -Path (Join-Path $source '*') -Destination $Dest -Recurse -Force
  } finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  }
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

Write-Host ''
Write-Host '============================================================' -ForegroundColor White
Write-Host '  CRM Comercial  -  Instalador da IA local (WhatsApp)' -ForegroundColor White
Write-Host '============================================================' -ForegroundColor White

# ---------------------------------------------------------------- checagens
Write-Step 'Verificando o computador'
Write-Ok "projeto: $Root"

if (-not [Environment]::Is64BitOperatingSystem) { throw 'Este instalador exige Windows 64 bits.' }
Write-Ok 'Windows 64 bits'

$os = [Environment]::OSVersion.Version
Write-Ok "Windows $($os.Major).$($os.Minor) build $($os.Build)"

try {
  $ram = [math]::Round((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).TotalPhysicalMemory / 1GB, 1)
  if ($ram -lt 7) {
    Write-Warn "o computador tem $ram GB de RAM. Os modelos somam cerca de 1,7 GB em uso;"
    Write-Warn 'feche outros programas pesados durante o atendimento.'
  } else {
    Write-Ok "$ram GB de RAM"
  }
} catch {
  Write-Warn 'não foi possível ler a memória RAM (segue em frente).'
}

$probe = $AiHome
while (-not (Test-Path $probe) -and (Split-Path -Parent $probe)) { $probe = Split-Path -Parent $probe }
$driveLetter = (Get-Item $probe).PSDrive.Name
$freeGb = [math]::Round((Get-PSDrive $driveLetter).Free / 1GB, 1)
if ($freeGb -lt 5) {
  Write-Warn "só há $freeGb GB livres em ${driveLetter}:. São necessários ~5 GB para binários e modelos."
} else {
  Write-Ok "$freeGb GB livres em ${driveLetter}:"
}

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  Write-Warn 'curl.exe não encontrado; usarei Invoke-WebRequest (mais lento em arquivos grandes).'
}
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  Write-Warn 'tar.exe não encontrado (não é necessário; o instalador usa Expand-Archive).'
}

# ---------------------------------------------------------------- pastas
Write-Step 'Preparando as pastas em tools\ai'
foreach ($dir in @($AiHome, $DirLlama, $DirWhisper, $DirModels, $DirDownloads, $DirLogs, $DirRun)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}
Write-Ok $AiHome

# ---------------------------------------------------------------- llama.cpp
if (-not $SkipLlama) {
  Write-Step 'llama.cpp (motor de conversa, pacote oficial CPU x64)'
  $exe = Join-Path $DirLlama 'llama-server.exe'
  if ((Test-Path $exe) -and -not $Force) {
    Write-Ok 'llama-server.exe já instalado'
  } else {
    $asset = Find-GithubAsset 'ggml-org/llama.cpp' '^llama-b\d+-bin-win-cpu-x64\.zip$'
    Write-Host "    release $($asset.Tag): $($asset.Name)"
    $zip = Join-Path $DirDownloads $asset.Name
    Download-File $asset.Url $zip
    Expand-ZipAsset $zip $DirLlama 'llama-server.exe'
    if (-not (Test-Path $exe)) { throw "llama-server.exe não apareceu em $DirLlama." }
    Write-Ok "instalado em $DirLlama"
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- whisper.cpp
if (-not $SkipWhisper) {
  Write-Step 'whisper.cpp (transcrição local, pacote oficial x64)'
  $exe = Join-Path $DirWhisper 'whisper-server.exe'
  if ((Test-Path $exe) -and -not $Force) {
    Write-Ok 'whisper-server.exe já instalado'
  } else {
    $asset = Find-GithubAsset 'ggml-org/whisper.cpp' '^whisper-bin-x64\.zip$'
    Write-Host "    release $($asset.Tag): $($asset.Name)"
    $zip = Join-Path $DirDownloads $asset.Name
    Download-File $asset.Url $zip
    Expand-ZipAsset $zip $DirWhisper 'whisper-server.exe'
    if (-not (Test-Path $exe)) { throw "whisper-server.exe não apareceu em $DirWhisper." }
    Write-Ok "instalado em $DirWhisper"
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
}

# ---------------------------------------------------------------- modelos
if (-not $SkipModels) {
  Write-Step 'Modelos (Hugging Face - fontes oficiais dos projetos)'
  Write-Host "    ~1,7 GB no total; o download pode levar alguns minutos."

  $qwen = Join-Path $DirModels $QwenFile
  Download-File 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf' $qwen

  $whisperBin = Join-Path $DirModels $WhisperModel
  Download-File "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WhisperModel" $whisperBin
}

# ---------------------------------------------------------------- verificação
Write-Step 'Conferindo a instalação'

$checks = @(
  @{ Path = (Join-Path $DirLlama 'llama-server.exe'); Skip = $SkipLlama; Label = 'llama-server.exe' },
  @{ Path = (Join-Path $DirWhisper 'whisper-server.exe'); Skip = $SkipWhisper; Label = 'whisper-server.exe' },
  @{ Path = (Join-Path $DirModels $QwenFile); Skip = $SkipModels; Label = $QwenFile },
  @{ Path = (Join-Path $DirModels $WhisperModel); Skip = $SkipModels; Label = $WhisperModel }
)
$faltando = 0
foreach ($c in $checks) {
  if ($c.Skip) { continue }
  if (Test-Path $c.Path) { Write-Ok $c.Label } else { Write-Fail "$($c.Label) ausente"; $faltando++ }
}

Write-Host ''
if ($faltando -gt 0) {
  Write-Host 'Instalação incompleta. Rode de novo para baixar o que faltou.' -ForegroundColor Yellow
  exit 1
}

Write-Host '============================================================' -ForegroundColor Green
Write-Host '  Instalação concluída.' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Write-Host ''
Write-Host 'Próximos passos:' -ForegroundColor White
Write-Host '  1) INICIAR_IA_VOZ.bat      -> sobe llama.cpp (8080) e whisper.cpp (8081)'
Write-Host '  2) run-crm.bat             -> sobe o CRM em http://localhost:3001'
Write-Host '  3) Abra um lead > aba "IA no WhatsApp" (resposta automática e ligações).'
Write-Host ''
Write-Host 'Teste rápido dos motores:'
Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\ai\test-ai.ps1'
Write-Host ''
Write-Host 'Documentação completa: backend\AI_VOZ.md' -ForegroundColor White
