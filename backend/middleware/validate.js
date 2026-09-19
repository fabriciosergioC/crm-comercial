const { ApiError } = require('./errorHandler');

/* ===========================================================================
   Validação de entrada da API.

   Nada chega ao banco sem passar por aqui. Cobre o que a seção 16 do escopo
   pede: campos obrigatórios, tipos, formatos, valores inválidos, tamanho, ids
   e relacionamentos. Também recusa CAMPOS DESCONHECIDOS (whitelist), para a
   API não virar uma porta de escrita para qualquer coluna.

   Convenção de retorno: o campo não enviado volta como `undefined`
   (no insert o banco aplica o DEFAULT; no update a coluna fica intacta).
   =========================================================================== */

function ensureObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'Corpo da requisição deve ser um objeto JSON.');
  }
  return body;
}

function rejectUnknown(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new ApiError(400, 'Campo(s) não aceito(s): ' + unknown.join(', '));
  }
}

function isBlank(v) { return v === undefined || v === null || v === ''; }

/* Texto. required => não pode faltar nem ser vazio.
   allowEmpty => string vazia é aceita como valor (usado para "limpar" um
   campo de texto em um PATCH); sem isso, vazio significa "não enviado". */
function str(body, field, { required = false, max = 1000, allowEmpty = false } = {}) {
  const v = body[field];
  if (v === undefined || v === null) {
    if (required) throw new ApiError(400, 'Campo obrigatório: ' + field);
    return undefined;
  }
  if (typeof v !== 'string') throw new ApiError(400, 'Campo deve ser texto: ' + field);
  const t = v.trim();
  if (t.length === 0) {
    if (required) throw new ApiError(400, 'Campo obrigatório: ' + field);
    return allowEmpty ? '' : undefined;
  }
  if (t.length > max) throw new ApiError(400, 'Campo longo demais (máx ' + max + '): ' + field);
  return t;
}

/* Valor de lista fechada (enum). `def` é usado quando o campo não vem. */
function oneOf(body, field, list, { required = false, def } = {}) {
  const v = body[field];
  if (isBlank(v)) {
    if (required) throw new ApiError(400, 'Campo obrigatório: ' + field);
    return def;
  }
  if (!list.includes(v)) {
    throw new ApiError(400, 'Valor inválido para ' + field + ': "' + v + '". Permitidos: ' + list.join(', ') + '.');
  }
  return v;
}

function num(body, field, { required = false, min = -1e12, max = 1e12, def } = {}) {
  const v = body[field];
  if (isBlank(v)) {
    if (required) throw new ApiError(400, 'Campo obrigatório: ' + field);
    return def;
  }
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw new ApiError(400, 'Campo deve ser numérico: ' + field);
  if (n < min || n > max) throw new ApiError(400, 'Valor fora do intervalo permitido em ' + field + '.');
  return n;
}

function int(body, field, opts = {}) {
  const n = num(body, field, opts);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) throw new ApiError(400, 'Campo deve ser inteiro: ' + field);
  return n;
}

function bool(body, field, { def } = {}) {
  const v = body[field];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw new ApiError(400, 'Campo deve ser booleano: ' + field);
  return v;
}

/* Data/hora: aceita o que o front-end manda (ISO) e devolve ISO normalizado. */
function isoDate(body, field, { required = false } = {}) {
  const v = body[field];
  if (isBlank(v)) {
    if (required) throw new ApiError(400, 'Campo obrigatório: ' + field);
    return undefined;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Data inválida em ' + field + '.');
  return d.toISOString();
}

/* Objeto simples (sem array/null) – usado em campos jsonb. */
function jsonObject(body, field, { required = false } = {}) {
  const v = body[field];
  if (v === undefined || v === null) {
    if (required) throw new ApiError(400, 'Campo obrigatório: ' + field);
    return undefined;
  }
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ApiError(400, 'Campo deve ser um objeto: ' + field);
  }
  return v;
}

/* score: { dor, facilidade, pagamento, recorrencia } com notas 0 a 5 —
   exatamente o que o front-end edita nas barras de pontuação. */
const SCORE_KEYS = ['dor', 'facilidade', 'pagamento', 'recorrencia'];

function score(body, field = 'score') {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ApiError(400, field + ' deve ser um objeto com ' + SCORE_KEYS.join(', ') + '.');
  }
  const unknown = Object.keys(v).filter((k) => !SCORE_KEYS.includes(k));
  if (unknown.length) throw new ApiError(400, 'Chave não aceita em ' + field + ': ' + unknown.join(', '));
  const out = {};
  for (const k of SCORE_KEYS) {
    if (v[k] === undefined) continue;
    const n = Number(v[k]);
    if (!Number.isInteger(n) || n < 0 || n > 5) {
      throw new ApiError(400, field + '.' + k + ' deve ser inteiro de 0 a 5.');
    }
    out[k] = n;
  }
  return out;
}

/* nextAction: { date, note } - a próxima ação combinada com o lead. */
function nextAction(body, field = 'nextAction') {
  const v = body[field];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new ApiError(400, field + ' deve ser um objeto { date, note }.');
  }
  const unknown = Object.keys(v).filter((k) => !['date', 'note'].includes(k));
  if (unknown.length) throw new ApiError(400, 'Chave não aceita em ' + field + ': ' + unknown.join(', '));
  const out = {};
  if (!isBlank(v.date)) {
    const d = new Date(v.date);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, 'Data inválida em ' + field + '.date.');
    out.date = d.toISOString();
  } else {
    out.date = null;
  }
  out.note = isBlank(v.note) ? '' : String(v.note).slice(0, 500);
  return out.date === null && out.note === '' ? null : out;
}

module.exports = {
  ensureObject, rejectUnknown, str, oneOf, num, int, bool, isoDate,
  jsonObject, score, nextAction, SCORE_KEYS, isBlank,
};