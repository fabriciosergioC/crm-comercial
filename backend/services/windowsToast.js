"use strict";

/* Notificação nativa do Windows (toast), sem instalar nada.

   O script PowerShell usa o Windows.UI.Notifications.ToastNotificationManager,
   que já vem no Windows 10/11 — testado nesta máquina (Windows 11 Home,
   PowerShell 5.1). Os textos vão embutidos no próprio script e o script vai
   codificado em base64 UTF-16LE (-EncodedCommand), então acentos, quebras de
   linha e aspas não dependem do code page do console.

   Cada toast é um processo PowerShell curto que morre sozinho; nada fica
   rodando e nada é gravado em disco. */

const { spawn } = require("child_process");

const APP_ID = process.env.WINDOWS_TOAST_APP_ID || "Gestão Comercial CRM";
const TIMEOUT_MS = Number(process.env.WINDOWS_TOAST_TIMEOUT_MS || 30000);

function psText(value) {
  const text = String(value == null ? "" : value).replace(/\r/g, "");
  /* PowerShell: literal entre aspas simples — só a aspa simples precisa
     dobrada. Títulos longos viram "…" para não estourar o toast. */
  const clipped = text.length > 320 ? `${text.slice(0, 319)}…` : text;
  return `'${clipped.replace(/'/g, "''")}'`;
}

function buildScript({ title, body, tag }) {
  return [
    "$ErrorActionPreference='Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$texts = $template.GetElementsByTagName('text')",
    `$texts.Item(0).AppendChild($template.CreateTextNode(${psText(title)})) | Out-Null`,
    `$texts.Item(1).AppendChild($template.CreateTextNode(${psText(body)})) | Out-Null`,
    "$texts.Item(1).SetAttribute('hint-wrap', 'true') | Out-Null",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $template",
    tag ? `try { $toast.Tag = ${psText(tag)}; $toast.Group = 'crm-agenda' } catch { }` : "try { $toast.Group = 'crm-agenda' } catch { }",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psText(APP_ID)}).Show($toast)`,
    "Write-Output 'CRM_TOAST_OK'",
  ].join("\n");
}

function isSupported() {
  return process.platform === "win32";
}

/* Mostra um toast. Resolve { ok, reason?, stderr? } — nunca rejeita: notificação
   é conveniência e não pode derrubar o agendador nem a request HTTP. */
function show({ title, body, tag } = {}) {
  if (!isSupported()) {
    return Promise.resolve({ ok: false, reason: "not-windows" });
  }
  const script = buildScript({ title, body, tag });
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (error) {
      resolve({ ok: false, reason: "spawn-failed", stderr: error.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* já saiu */ }
      finish({ ok: false, reason: "timeout", stderr: stderr.slice(0, 400) });
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ ok: false, reason: "spawn-error", stderr: error.message }));
    child.on("close", (code) => {
      const ok = code === 0 && stdout.includes("CRM_TOAST_OK");
      finish(ok ? { ok: true } : { ok: false, reason: `powershell-saiu-${code}`, stderr: stderr.slice(0, 400) });
    });
  });
}

/* Atalho usado pelo agendador e pelo endpoint de teste. */
function notify(title, body, tag) {
  return show({ title, body, tag });
}

module.exports = { show, notify, isSupported, buildScript, APP_ID };
