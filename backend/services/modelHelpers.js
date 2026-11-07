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

/* Traduz a falha do banco em uma frase curta, em português, que pode ir para a
   tela. O erro vem em camadas e o Supabase não preserva o cause do fetch: ele
   copia a stack para dentro de error.details ("Caused by: Error: getaddrinfo
   ENOTFOUND ..."), enquanto message fica no genérico "TypeError: fetch failed"
   e code vem vazio. Por isso lemos message + details + hint + code das causas.
   O que importa quase sempre está no code: ENOTFOUND é projeto pausado/apagado
   ou URL errada, e dizer só "fetch failed" deixa quem usa batendo em
   run-crm.bat. Nada aqui devolve URL completa, chave nem SQL. */
function motivoFalhaDoBanco(error) {
  if (!error) return 'o banco não respondeu';

  const sinais = [];
  const empilhar = (e, profundidade) => {
    if (!e || profundidade > 4) return;
    if (typeof e === 'string') { sinais.push(e.toLowerCase()); return; }
    sinais.push(String(e.code || '').toLowerCase());
    sinais.push(String(e.errno || '').toLowerCase());
    sinais.push(String(e.message || '').toLowerCase());
    sinais.push(String(e.details || '').toLowerCase());
    sinais.push(String(e.hint || '').toLowerCase());
    empilhar(e.cause, profundidade + 1);
  };
  empilhar(error, 0);
  const tudo = sinais.join(' | ');
  const semDetalhe = () => {
    /* "fetch failed" não diz nada; se details trouxe o code, mostramos o code
       entre parênteses para a pessoa pesquisar. */
    const primeira = String((error && error.message) || error || '').trim();
    return primeira ? primeira.slice(0, 180) : 'motivo desconhecido retornado pelo banco';
  };

  if (tudo.includes('enotfound') || tudo.includes('getaddrinfo') || tudo.includes('eai_again')) {
    return 'o endereço do banco não existe no DNS (ENOTFOUND). O projeto do Supabase está pausado, foi apagado, ou o SUPABASE_URL do .env é de outro projeto.';
  }
  if (tudo.includes('econnrefused')) return 'a conexão com o banco foi recusada (ECONNREFUSED).';
  if (tudo.includes('etimedout') || tudo.includes('esockettimedout') || tudo.includes('enetunreach') || tudo.includes('ehostunreach')) {
    return 'a máquina não chegou ao banco (sem rede, VPN ou firewall bloqueando o Supabase).';
  }
  if (tudo.includes('certificate') || tudo.includes('unable_to_verify') || tudo.includes('self_signed')) {
    return 'o certificado TLS do banco foi rejeitado (antivírus, proxy ou filtro de rede interceptando o HTTPS).';
  }
  if (tudo.includes('pgrst205') || tudo.includes('pgrst202') || tudo.includes('42p01')
    || (tudo.includes('relation') && tudo.includes('does not exist'))
    || tudo.includes('schema cache') || tudo.includes('does not exist')) {
    return 'a tabela não existe neste banco (projeto novo ou schema não aplicado). Cole backend/database/banco_novo.sql no SQL Editor do Supabase e rode uma vez.';
  }
  if (tudo.includes('pgrst301') || tudo.includes('jwt_expired') || tudo.includes('invalid_login_api_key')
    || tudo.includes('apikey') || tudo.includes('unauthorized')) {
    return 'a chave do banco foi recusada (SUPABASE_SERVICE_ROLE_KEY não bate com este projeto ou expirou).';
  }
  if (tudo.includes('pgrst902') || tudo.includes('permission denied')) {
    return 'o banco recusou a consulta: ' + semDetalhe();
  }
  if (tudo.includes('fetch failed') || tudo.includes('failed to fetch')) return semDetalhe();

  return semDetalhe();
}

/* Traduz erro do Supabase/PostgREST em ApiError, sem vazar SQL nem detalhe
   interno: mensagens 4xx são seguras, 5xx viram mensagem genérica — mas agora
   com o motivo da falha de conexão no fim, porque "falha ao acessar o banco"
   sozinho mandava a pessoa reiniciar o backend que estava perfeito. */
function mapDbError(error, fallback) {
  const code = error && error.code;
  if (code === '23514') return new ApiError(400, 'Dados inválidos: valor fora do permitido.');
  if (code === '23502') return new ApiError(400, 'Campo obrigatório ausente.');
  if (code === '23503') return new ApiError(400, 'Referência inválida: registro relacionado não existe.');
  if (code === '23505') return new ApiError(409, 'Registro já existe.');
  if (code === 'PGRST116') return new ApiError(404, 'Registro não encontrado.');
  /* O ponto final do fallback é cortado antes dos dois-pontos: sem isso a tela
     saía com "Falha ao listar os usuários.: a tabela não existe...". */
  const base = String(fallback || 'Falha ao acessar o banco de dados').replace(/[.\s]+$/, '');
  return new ApiError(502, base + ': ' + motivoFalhaDoBanco(error));
}

/* Ids de texto, no mesmo estilo do front-end ("f_...", "d_...", "p_..."),
   com sufixo aleatório para não colidir quando dois registros nascem no
   mesmo milissegundo. Usado apenas quando o cliente não envia um id. */
function newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

module.exports = { buildMapper, parseFilters, parseLimit, mapDbError, motivoFalhaDoBanco, newId };