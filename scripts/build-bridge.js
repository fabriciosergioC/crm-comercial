/* Build do executável-ponte do WhatsApp (CRM Comercial).
   1. Lê backend/.env (Supabase) em tempo de build — o segredo nunca é commitado.
   2. Empacota packaged/bridge-entry.js com esbuild (ESM->CJS), injetando o
      Supabase via define (fica somente no binário em dist/, que é gitignored).
   3. Monta um auto-extrator (WinRAR SFX) com runtime Node real + bundle +
      launcher, gerando dist/CRM-WhatsApp-Bridge.exe (autocontido: roda na
      máquina alvo sem Node/WinRAR instalados).
   Uso: npm run build:bridge */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const esbuild = require('esbuild');
const ffmpegPath = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, 'backend', '.env');
const WINRAR = 'C:\\Program Files\\WinRAR\\WinRAR.exe';
const DIST = path.join(ROOT, 'dist');
const SFX_SRC = path.join(DIST, 'sfx-src');

function readEnv() {
  const raw = fs.readFileSync(ENV_PATH, 'utf8');
  const get = (k) => {
    const m = raw.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  return { url: get('SUPABASE_URL'), key: get('SUPABASE_SERVICE_ROLE_KEY') };
}

const LAUNCHER_BAT = [
  '@echo off',
  'title Ponte do WhatsApp - CRM Comercial',
  'set "FFMPEG_BIN=%~dp0ffmpeg.exe"',
  '"%~dp0node.exe" "%~dp0bridge.bundle.cjs"',
  'echo.',
  'echo Processo encerrado. Pressione uma tecla para fechar.',
  'pause >nul',
  '',
].join('\r\n');

const SFX_COMMENT = [
  ';The comment below contains SFX script:',
  'Setup=run-bridge.bat',
  'Path=%TEMP%\\crm-whatsapp-bridge',
  'Silent=1',
  'Overwrite=1',
  'Title=Ponte do WhatsApp - CRM Comercial',
  '',
].join('\r\n');

async function main() {
  const { url, key } = readEnv();
  if (!url || !key) {
    console.error('ERRO: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ausentes em backend/.env');
    process.exit(1);
  }
  fs.mkdirSync(DIST, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'packaged', 'bridge-entry.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: path.join(DIST, 'bridge.bundle.cjs'),
    define: {
      __SUPABASE_URL__: JSON.stringify(url),
      __SUPABASE_SERVICE_ROLE__: JSON.stringify(key),
    },
    logLevel: 'warning',
  });
  console.log('[build] bundle OK -> dist/bridge.bundle.cjs');

  // Monta a pasta que será auto-extraída: runtime Node + bundle + launcher.
  fs.rmSync(SFX_SRC, { recursive: true, force: true });
  fs.mkdirSync(SFX_SRC, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(SFX_SRC, 'node.exe'));
  fs.copyFileSync(path.join(DIST, 'bridge.bundle.cjs'), path.join(SFX_SRC, 'bridge.bundle.cjs'));
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
    throw new Error('O binário ffmpeg-static não está disponível para incluir na ponte.');
  }
  fs.copyFileSync(ffmpegPath, path.join(SFX_SRC, 'ffmpeg.exe'));
  fs.writeFileSync(path.join(SFX_SRC, 'run-bridge.bat'), LAUNCHER_BAT);
  console.log('[build] pasta SFX montada -> dist/sfx-src');

  const commentPath = path.join(DIST, 'sfx-comment.txt');
  fs.writeFileSync(commentPath, SFX_COMMENT);
  const outExe = path.join(DIST, 'CRM-WhatsApp-Bridge.exe');
  fs.rmSync(outExe, { force: true });

  execFileSync(WINRAR, [
    'a', '-sfx', `-z${commentPath}`, '-ep1', '-r', '-y', '-m5',
    outExe, path.join(SFX_SRC, '*'),
  ], { stdio: 'inherit' });

  console.log('[build] exe OK ->', outExe);
}

main().catch((e) => { console.error(e); process.exit(1); });
