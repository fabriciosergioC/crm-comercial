const { ApiError } = require('../middleware/errorHandler');

/* ---------------------------------------------------------------------------
   Helpers compartilhados pelos services das coleções.

   Ficam em um arquivo separado para não repetir o mesmo mapeamento em 6
   services — e, principalmente, para NÃO alterar leadsService.js nem
   statusHistoryService.js, que já funcionam com o próprio mapeamento.
   --------------------------------------------------------------------------- */

/* Mapa { camelCase (front-end) : snake_case (Postgres) } -> toRow / fromRow.
   Mesma convenção usada por leadsService.COLUMNS. */
function buildMapper(columns) {
  const entries = Object.entries(columns);

  function toRow(data) {
    const row = {};
    for (const [camel, snake] of entries) {
      if (data && data[camel] !== undefined) row[snake] = data[camel];
    }
    return row;
  }

  function fromRow(row) {
    if (!row) return null;
    const out = {};
    for (const [camel, snake] of entries) {
      out[camel] = row[snake] !== undefined ? row[snake] : null;
    }
    return out;
  }

  return { toRow, fromRow };
}

/* Filtros da querystring (?leadId=..&status=..) -> lista de [coluna, valor].
   Só os campos declarados em `allowed` são aceitos; o resto é ignorado,
   evitando que a API vire um acesso genérico ao banco. */
function parseFilters(query, columns, allowed) {
  const filters = [];
  for (const key of allowed) {
    const value = query ? query[key] : undefined;
    if (value === undefined || value === '') continue;
    if (!columns[key]) throw new ApiError(500, 'Filtro não mapeado: ' + key);
    filters.push([columns[key], String(value)]);
  }
  return filters;
}

/* Limite de linhas com teto, para uma listagem não derrubar o servidor. */
function parseLimit(query, fallback = 500, max = 2000) {
  const n = Number(query ? query.limit : undefined);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/* Traduz erro do Supabase/PostgREST em ApiError, sem vazar SQL nem detalhe
   interno: mensagens 4xx são seguras, 5xx viram mensagem genérica. */
function mapDbError(error, fallback) {
  const code = error && error.code;
  if (code === '23514') return new ApiError(400, 'Dados inválidos: valor fora do permitido.');
  if (code === '23502') return new ApiError(400, 'Campo obrigatório ausente.');
  if (code === '23503') return new ApiError(400, 'Referência inválida: registro relacionado não existe.');
  if (code === '23505') return new ApiError(409, 'Registro já existe.');
  if (code === 'PGRST116') return new ApiError(404, 'Registro não encontrado.');
  return new ApiError(502, fallback || 'Falha ao acessar o banco de dados.');
}

/* Ids de texto, no mesmo estilo do front-end ("f_...", "d_...", "p_..."),
   com sufixo aleatório para não colidir quando dois registros nascem no
   mesmo milissegundo. Usado apenas quando o cliente não envia um id. */
function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

module.exports = { buildMapper, parseFilters, parseLimit, mapDbError, newId };