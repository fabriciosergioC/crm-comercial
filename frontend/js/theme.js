// ============================================================================
//  Tema da tela (window.GCTheme) — temas completos + cor de destaque livre
// ============================================================================
//  O design system guarda TODAS as cores em tokens CSS definidos em .gc-root
//  (index.html): superfícies (--paper/--surface/--ink/--line...), o acento da
//  marca (--accent/--accent-ink/--accent-soft/--accent-soft-strong) e as cores
//  de status (--danger/--success/--warn/--tone-*...).
//
//  Aqui montamos temas PROFISSIONAIS completos (claro e escuro). Cada tema
//  define superfícies + acento; os tokens de status vêm de uma base clara ou
//  escura conforme o modo do tema. O usuário ainda pode escolher uma COR DE
//  DESTAQUE personalizada, que sobrescreve a família --accent* do tema ativo.
//
//  Aplicamos tudo num <style id="gc-theme-override"> com seletor .gc-root.gc-root
//  (especificidade maior que o .gc-root do app), vencendo o tema padrão sem
//  editar o CSS compilado. Roda no <head> antes do React: aplica o tema salvo
//  sem "flash". Estado persistido em localStorage["gc_theme"] = {id, accent}.
// ============================================================================
(function () {
  var STORAGE_KEY = "gc_theme";
  var LEGACY_ACCENT_KEY = "gc_theme_accent"; // versão anterior (só acento)
  var STYLE_ID = "gc-theme-override";
  var DEFAULT_THEME_ID = "petroleo";

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function hexToRgb(hex) {
    var h = String(hex || "").trim().replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h = 0, s = 0, l = (max + min) / 2, d = max - min;
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
    var m = l - c / 2, r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    var to = function (v) { var n = Math.round((v + m) * 255); return (n < 16 ? "0" : "") + n.toString(16); };
    return "#" + to(r) + to(g) + to(b);
  }

  // Tokens de STATUS por modo (semânticos; não mudam com o acento).
  var STATUS = {
    light: {
      "--tone-slate-bg": "#ECEBE6", "--tone-slate-fg": "#5C5F55",
      "--tone-amber-bg": "#FBF0D9", "--tone-amber-fg": "#8A6413",
      "--tone-blue-bg": "#E1EBF5", "--tone-blue-fg": "#2A5788",
      "--tone-violet-bg": "#EAE5F6", "--tone-violet-fg": "#5B3F9E",
      "--tone-teal-bg": "#DCEEEA", "--tone-teal-fg": "#1F6E5C",
      "--tone-green-bg": "#DEEEDD", "--tone-green-fg": "#2C6B34",
      "--tone-red-bg": "#F7E2DD", "--tone-red-fg": "#A23E28",
      "--hot": "#B23B22", "--hot-bg": "#F7E2DD",
      "--warm": "#93690F", "--warm-bg": "#FBF0D9",
      "--cold": "#4C5B6B", "--cold-bg": "#E7EAEE",
      "--danger": "#A23E28", "--danger-bg": "#F7E2DD",
      "--success": "#2C6B34", "--success-bg": "#DEEEDD",
      "--warn": "#93690F", "--warn-bg": "#FBF0D9"
    },
    dark: {
      "--tone-slate-bg": "#2A2E35", "--tone-slate-fg": "#B7BDC7",
      "--tone-amber-bg": "#38301F", "--tone-amber-fg": "#E4C483",
      "--tone-blue-bg": "#1E2C3E", "--tone-blue-fg": "#93B8EA",
      "--tone-violet-bg": "#2C2740", "--tone-violet-fg": "#BBA9F1",
      "--tone-teal-bg": "#16322F", "--tone-teal-fg": "#82D3C8",
      "--tone-green-bg": "#1B3221", "--tone-green-fg": "#92D69C",
      "--tone-red-bg": "#3A2220", "--tone-red-fg": "#F1AA9C",
      "--hot": "#F1AA9C", "--hot-bg": "#3A2220",
      "--warm": "#E4C483", "--warm-bg": "#38301F",
      "--cold": "#A2B4C6", "--cold-bg": "#222A31",
      "--danger": "#F1AA9C", "--danger-bg": "#3A2220",
      "--success": "#92D69C", "--success-bg": "#1B3221",
      "--warn": "#E4C483", "--warn-bg": "#38301F"
    }
  };

  // Cada tema define superfícies + acento. Status vem de STATUS[mode].
  var THEMES = [
    { id: "petroleo", name: "Petróleo", mode: "light", tokens: {
      "--paper": "#F6F5F1", "--surface": "#FFFFFF", "--surface-sunken": "#F0EEE8",
      "--ink": "#1B1E23", "--ink-soft": "#4A5058", "--slate": "#6B7280",
      "--line": "#E4E1D8", "--line-strong": "#D3CFC3",
      "--accent": "#2C5F72", "--accent-ink": "#17414F", "--accent-soft": "#DEEBEE", "--accent-soft-strong": "#C7DEE2" } },

    { id: "corporativo", name: "Azul Corporativo", mode: "light", tokens: {
      "--paper": "#F4F6F9", "--surface": "#FFFFFF", "--surface-sunken": "#EDF1F6",
      "--ink": "#131A24", "--ink-soft": "#3E4A5A", "--slate": "#64748B",
      "--line": "#E2E7EE", "--line-strong": "#CBD4DF",
      "--accent": "#1D4E89", "--accent-ink": "#123A67", "--accent-soft": "#E3ECF7", "--accent-soft-strong": "#CBDCEE" } },

    { id: "grafite", name: "Grafite", mode: "light", tokens: {
      "--paper": "#F5F5F4", "--surface": "#FFFFFF", "--surface-sunken": "#ECECEA",
      "--ink": "#17181A", "--ink-soft": "#45484E", "--slate": "#6E7278",
      "--line": "#E3E3E0", "--line-strong": "#D0D0CC",
      "--accent": "#3F4750", "--accent-ink": "#2A3037", "--accent-soft": "#E7E9EB", "--accent-soft-strong": "#D3D7DB" } },

    { id: "verde", name: "Verde Sóbrio", mode: "light", tokens: {
      "--paper": "#F4F6F2", "--surface": "#FFFFFF", "--surface-sunken": "#EBEFE7",
      "--ink": "#161C16", "--ink-soft": "#3F4A3E", "--slate": "#6A7469",
      "--line": "#E1E6DC", "--line-strong": "#CDD4C7",
      "--accent": "#2F6B3A", "--accent-ink": "#1F4A27", "--accent-soft": "#E3EEE4", "--accent-soft-strong": "#CBDFCD" } },

    { id: "vinho", name: "Vinho", mode: "light", tokens: {
      "--paper": "#F7F4F3", "--surface": "#FFFFFF", "--surface-sunken": "#F1EAE8",
      "--ink": "#1D1516", "--ink-soft": "#4C3E40", "--slate": "#7A6A6C",
      "--line": "#E8DEDC", "--line-strong": "#D8C9C6",
      "--accent": "#8C2F39", "--accent-ink": "#651F27", "--accent-soft": "#F3E1E2", "--accent-soft-strong": "#E7C9CB" } },

    { id: "sepia", name: "Âmbar Sépia", mode: "light", tokens: {
      "--paper": "#F8F5EE", "--surface": "#FFFFFF", "--surface-sunken": "#F2EDE1",
      "--ink": "#211C13", "--ink-soft": "#4E4636", "--slate": "#7A7263",
      "--line": "#E9E2D4", "--line-strong": "#D8CFBC",
      "--accent": "#8A5A12", "--accent-ink": "#5F3E0B", "--accent-soft": "#F4EAD6", "--accent-soft-strong": "#EADCC0" } },

    { id: "violeta", name: "Violeta", mode: "light", tokens: {
      "--paper": "#F6F4F9", "--surface": "#FFFFFF", "--surface-sunken": "#EFEBF5",
      "--ink": "#1A1721", "--ink-soft": "#47415A", "--slate": "#6E6883",
      "--line": "#E5E1EE", "--line-strong": "#D2CBE0",
      "--accent": "#5B3F9E", "--accent-ink": "#422C77", "--accent-soft": "#EAE5F6", "--accent-soft-strong": "#D9D0EE" } },

    { id: "escuro", name: "Escuro", mode: "dark", tokens: {
      "--paper": "#14171A", "--surface": "#1B1F24", "--surface-sunken": "#22272D",
      "--ink": "#E7EAEE", "--ink-soft": "#B4BAC3", "--slate": "#8A929C",
      "--line": "#2A3038", "--line-strong": "#3A424C",
      "--accent": "#4E9BB0", "--accent-ink": "#CDEAF2", "--accent-soft": "#1D363E", "--accent-soft-strong": "#2A4C56" } },

    { id: "escuro-azul", name: "Escuro Azul", mode: "dark", tokens: {
      "--paper": "#12151B", "--surface": "#191D26", "--surface-sunken": "#20252F",
      "--ink": "#E6E9F0", "--ink-soft": "#B0B7C6", "--slate": "#848DA0",
      "--line": "#262C38", "--line-strong": "#363E4E",
      "--accent": "#5B8FD6", "--accent-ink": "#D6E4FB", "--accent-soft": "#1E2C42", "--accent-soft-strong": "#2C405E" } }
  ];

  function byId(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return null;
  }

  // Deriva a família --accent* a partir de uma cor, respeitando o modo do tema.
  function deriveAccent(hex, mode) {
    var rgb = hexToRgb(hex);
    if (!rgb) return null;
    var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    var h = hsl.h, s = hsl.s, l = hsl.l;
    if (mode === "dark") {
      return {
        "--accent": hslToHex(h, clamp(s, 25, 85), clamp(l, 45, 65)),
        "--accent-ink": hslToHex(h, clamp(s * 0.45, 12, 55), 90),
        "--accent-soft": hslToHex(h, clamp(s * 0.55, 12, 50), 17),
        "--accent-soft-strong": hslToHex(h, clamp(s * 0.55, 12, 50), 25)
      };
    }
    return {
      "--accent": hslToHex(h, s, clamp(l, 20, 55)),
      "--accent-ink": hslToHex(h, clamp(s * 1.2, 0, 100), clamp(l * 0.62, 8, 40)),
      "--accent-soft": hslToHex(h, clamp(s * 0.6, 12, 60), 92),
      "--accent-soft-strong": hslToHex(h, clamp(s * 0.62, 14, 62), 84)
    };
  }

  var state = { id: DEFAULT_THEME_ID, accent: null };

  function resolvedTokens() {
    var theme = byId(state.id) || byId(DEFAULT_THEME_ID);
    var base = STATUS[theme.mode] || STATUS.light;
    var out = {};
    var k;
    for (k in base) out[k] = base[k];
    for (k in theme.tokens) out[k] = theme.tokens[k];
    if (state.accent) {
      var a = deriveAccent(state.accent, theme.mode);
      if (a) for (k in a) out[k] = a[k];
    }
    return out;
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

  function writeOverride() {
    var t = resolvedTokens();
    var css = ".gc-root.gc-root{";
    for (var k in t) css += k + ":" + t[k] + ";";
    css += "}";
    ensureStyleEl().textContent = css;
  }

  function persist() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: state.id, accent: state.accent })); } catch (_) {}
  }

  function applyTheme(id) {
    if (!byId(id)) return false;
    state.id = id;
    writeOverride();
    persist();
    return true;
  }

  function applyAccent(hex) {
    if (!hexToRgb(hex)) return false;
    state.accent = hex;
    writeOverride();
    persist();
    return true;
  }

  function clearAccent() {
    state.accent = null;
    writeOverride();
    persist();
  }

  function reset() {
    state = { id: DEFAULT_THEME_ID, accent: null };
    try { window.localStorage.removeItem(STORAGE_KEY); window.localStorage.removeItem(LEGACY_ACCENT_KEY); } catch (_) {}
    writeOverride();
  }

  function getState() { return { id: state.id, accent: state.accent }; }

  function load() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && byId(s.id)) {
          state.id = s.id;
          state.accent = (s.accent && hexToRgb(s.accent)) ? s.accent : null;
          return;
        }
      }
      var legacy = window.localStorage.getItem(LEGACY_ACCENT_KEY);
      if (legacy && hexToRgb(legacy)) state.accent = legacy;
    } catch (_) {}
  }

  window.GCTheme = {
    THEMES: THEMES,
    DEFAULT_THEME_ID: DEFAULT_THEME_ID,
    byId: byId,
    deriveAccent: deriveAccent,
    applyTheme: applyTheme,
    applyAccent: applyAccent,
    clearAccent: clearAccent,
    reset: reset,
    getState: getState,
    isValid: function (hex) { return !!hexToRgb(hex); }
  };

  load();
  writeOverride();
})();
