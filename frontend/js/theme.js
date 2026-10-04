// ============================================================================
//  Tema de cor do usuário (window.GCTheme)
// ============================================================================
//  O design system guarda a cor da marca nos tokens --accent / --accent-ink /
//  --accent-soft / --accent-soft-strong, definidos em .gc-root (index.html).
//  Aqui derivamos esses 4 tokens a partir de UMA cor escolhida pelo usuário e
//  injetamos um <style> com seletor .gc-root.gc-root (especificidade maior que
//  o .gc-root do app), garantindo que o tema vença sem editar o CSS compilado.
//
//  Roda no <head> antes do React: aplica a cor salva sem "flash" do tema padrão.
// ============================================================================
(function () {
  var STORAGE_KEY = "gc_theme_accent";
  var STYLE_ID = "gc-theme-override";
  var DEFAULT_ACCENT = "#2C5F72";

  // Cores prontas oferecidas no seletor (além do color picker livre).
  var PRESETS = [
    { name: "Padrão (petróleo)", hex: "#2C5F72" },
    { name: "Azul", hex: "#2A5788" },
    { name: "Verde", hex: "#2C6B34" },
    { name: "Violeta", hex: "#5B3F9E" },
    { name: "Vinho", hex: "#8C2F39" },
    { name: "Terracota", hex: "#A23E28" },
    { name: "Âmbar", hex: "#8A6413" },
    { name: "Grafite", hex: "#3A3F46" },
  ];

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function hexToRgb(hex) {
    var h = String(hex || "").trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2;
    var d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    return { h: h, s: s * 100, l: l * 100 };
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2;
    var r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    var to = function (v) { var n = Math.round((v + m) * 255); return (n < 16 ? "0" : "") + n.toString(16); };
    return "#" + to(r) + to(g) + to(b);
  }

  // Deriva os 4 tokens de acento a partir da cor-base, calibrado para bater
  // com os valores originais do design system (accent #2C5F72).
  function derive(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return null;
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    var h = hsl.h, s = hsl.s, l = hsl.l;
    return {
      accent: hslToHex(h, s, l),
      accentInk: hslToHex(h, clamp(s * 1.2, 0, 100), clamp(l * 0.62, 8, 40)),
      accentSoft: hslToHex(h, clamp(s * 0.6, 12, 60), 92),
      accentSoftStrong: hslToHex(h, clamp(s * 0.62, 14, 62), 84),
    };
  }

  function ensureStyleEl() {
    var el = document.getElementById(STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function apply(hex) {
    var tokens = derive(hex);
    if (!tokens) return false;
    var css = ".gc-root.gc-root{" +
      "--accent:" + tokens.accent + ";" +
      "--accent-ink:" + tokens.accentInk + ";" +
      "--accent-soft:" + tokens.accentSoft + ";" +
      "--accent-soft-strong:" + tokens.accentSoftStrong + ";" +
      "}";
    ensureStyleEl().textContent = css;
    try { window.localStorage.setItem(STORAGE_KEY, tokens.accent); } catch (_) {}
    return true;
  }

  function reset() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    var el = document.getElementById(STYLE_ID);
    if (el) el.textContent = "";
  }

  function get() {
    try { return window.localStorage.getItem(STORAGE_KEY) || DEFAULT_ACCENT; }
    catch (_) { return DEFAULT_ACCENT; }
  }

  window.GCTheme = {
    PRESETS: PRESETS,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    derive: derive,
    apply: apply,
    reset: reset,
    get: get,
    isValid: function (hex) { return !!hexToRgb(hex); },
  };

  // Aplica imediatamente a cor salva (antes do React renderizar).
  var saved = null;
  try { saved = window.localStorage.getItem(STORAGE_KEY); } catch (_) {}
  if (saved) apply(saved);
})();
