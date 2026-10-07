"use strict";

const { spawn } = require("node:child_process");

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CONVERSION_TIMEOUT_MS = 30000;

function convertToOggOpus(input) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_BIN || require("ffmpeg-static");
    if (!ffmpegPath) {
      reject(new Error("O executável FFmpeg não está disponível neste sistema."));
      return;
    }

    let child;
    try {
      child = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-i", "pipe:0",
        "-map", "0:a:0",
        "-vn",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "libopus",
        "-avoid_negative_ts", "make_zero",
        "-f", "ogg",
        "pipe:1",
      ], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new Error(`Não foi possível iniciar a conversão de áudio: ${error.message}`));
      return;
    }

    const output = [];
    let outputBytes = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("A conversão do áudio excedeu o tempo limite."));
    }, CONVERSION_TIMEOUT_MS);

    function finish(error, buffer) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(buffer);
    }

    child.stdout.on("data", chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("O áudio convertido excede o limite de 8 MB."));
        return;
      }
      output.push(chunk);
    });
    child.stderr.on("data", chunk => {
      if (stderr.length < 8192) stderr += chunk.toString();
    });
    child.on("error", error => finish(new Error(`Falha ao executar FFmpeg: ${error.message}`)));
    child.on("close", code => {
      if (settled) return;
      if (code !== 0 || outputBytes === 0) {
        finish(new Error(`Não foi possível converter o áudio.${stderr.trim() ? ` ${stderr.trim()}` : ""}`));
        return;
      }
      finish(null, Buffer.concat(output, outputBytes));
    });
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") finish(new Error(`Falha ao fornecer o áudio para conversão: ${error.message}`));
    });
    child.stdin.end(input);
  });
}

module.exports = { convertToOggOpus };
