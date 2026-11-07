/* ---------------------------------------------------------------------------
   restaurar-leads-do-backup.js — traz de volta os leads que existiriam no
   snapshot local data/status-msg-backup.json.

   Por que este script existe: o projeto Supabase antigo saiu do ar e não sobrou
   dump nenhum do banco no computador. O único registro de clientes que ficou
   aqui foi aquele .json, gerado em 05/10/2026 às 17h17, pouco antes de uma
   troca de status. Ele guarda 147 leads com cinco campos: id, company,
   contact_name, status e updated_at. Telefone, cidade, notas, score,
   interações e follow-ups não estão lá — o que este script escreve é a lista
   de nomes, não o histórico.

   Mapeamento (decidido para bater com as constraints do schema.sql):
     - status "MSG 1: Saudação" e "MSG 2: Apresentação" viram
       "Contato pendente". É a mesma regra que o front-end já usou em
       12/10/2026, quando "Novo"/"Contatado" caíram para "Contato pendente".
       O rótulo antigo continua escrito em notes, então nada se perde.
     - created_at e updated_at recebem a data do snapshot.
     - source recebe "Prospecção ativa" (eram mensagens de abordagem no
       WhatsApp).
     - segment recebe "Estética" quando o nome da clínica deixa isso claro;
       nos outros casos fica vazio, porque a coluna só aceita a lista fixa.
     - owner é obrigatório e precisa existir na tabela users: 'erick' ou
       'fabricio'. Padrão: erick. Troque com --dono=fabricio.

   Uso:
     node scripts/restaurar-leads-do-backup.js              só mostra (dry-run)
     node scripts/restaurar-leads-do-backup.js --gravar     escreve no banco
     node scripts/restaurar-leads-do-backup.js --gravar --dono=fabricio

   Segurança: o script lê os ids que já estão na tabela leads e NÃO regrava
   esses — rodar duas vezes não duplica e não amassa correção manual. Nada
   aqui imprime a service_role key.
--------------------------------------------------------------------------- */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO_BACKUP = path.join(RAIZ, 'data', 'status-msg-backup.json');
const ARQUIVO_ENV = path.join(RAIZ, 'backend', '.env');
const LINHAS_POR_LOTE = 100;
const DONO_PADRAO = 'erick';
const USUARIOS_VALIDOS = ['erick', 'fabricio'];

/* ------------------------------------------------------------------ ambiente */

function carregarEnv() {
  try {
    require('dotenv').config({ path: ARQUIVO_ENV });
  } catch (erro) {
    require(path.join(RAIZ, 'backend', 'node_modules', 'dotenv')).config({ path: ARQUIVO_ENV });
  }
  const url = process.env.SUPABASE_URL;
  const chave = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !chave) {
    console.error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY em ' + ARQUIVO_ENV);
    process.exit(1);
  }
  return { url: url.replace(/\/+$/, ''), chave };
}

function criarCliente({ url, chave }) {
  let criar;
  try {
    criar = require('@supabase/supabase-js').createClient;
  } catch (erro) {
    criar = require(path.join(RAIZ, 'backend', 'node_modules', '@supabase', 'supabase-js')).createClient;
  }
  return criar(url, chave, { auth: { persistSession: false, autoRefreshToken: false } });
}

/* --------------------------------------------------------------------- leitura */

function carregarSnapshot() {
  if (!fs.existsSync(ARQUIVO_BACKUP)) {
    console.error('Não achei o snapshot em ' + ARQUIVO_BACKUP);
    process.exit(1);
  }
  const bruto = JSON.parse(fs.readFileSync(ARQUIVO_BACKUP, 'utf8'));
  const lista = Array.isArray(bruto.leads) ? bruto.leads : [];
  if (!lista.length) {
    console.error('O arquivo não tem a lista de leads (esperava a chave "leads").');
    process.exit(1);
  }
  return { geradoEm: bruto.at, alvoAntigo: bruto.target, lista };
}

/* Palavras que, sozinhas, já dizem que o negócio é de estética. A coluna
   segment tem CHECK com lista fixa, então na dúvida é melhor deixar vazio.
   "spa" é testado com fronteira de palavra porque "espaço" contains spa. */
const MARCAS_DE_ESTETICA = [
  'estetica', 'micropigmentacao', 'micropigmentação', 'harmonizacao', 'harmonização',
  'derma', 'laser', 'sobrancelha', 'cílios', 'cilios', 'day spa', 'rejuvenescimento',
  'skincare', 'skin', 'botox', 'limpeza de pele', 'design de sobrancelha',
];

function deduzirSegmento(lead) {
  const cheio = `${lead.company || ''} ${lead.contact_name || ''}`.toLowerCase();
  const bate = MARCAS_DE_ESTETICA.some((marca) => cheio.includes(marca))
    || /(^|\s)spa(\s|$)/.test(cheio)
    || /(^|\s)(estética|salão de beleza)(\s|$|,|-)/.test(cheio);
  return bate ? 'Estética' : null;
}

function notaDoLead(lead, geradoEm) {
  const data = String(geradoEm || '').slice(0, 10) || 'data desconhecida';
  const ultimoContato = String(lead.updated_at || '').slice(0, 10);
  return [
    `Importado do snapshot local de ${data} (data/status-msg-backup.json),`,
    `quando o projeto Supabase antigo saiu do ar.`,
    `Status na época: "${lead.status}".`,
    ultimoContato ? `Última movimentação registrada: ${ultimoContato}.` : '',
    'Telefone, cidade e histórico não estavam no snapshot — conferir antes do primeiro contato.',
  ].join(' ').replace(/\s+/g, ' ').trim();
}

function paraLinha(lead, geradoEm, dono) {
  const data = lead.updated_at || geradoEm || new Date().toISOString();
  const linha = {
    id: String(lead.id),
    company: String(lead.company || '').trim(),
    contact_name: String(lead.contact_name || '').trim(),
    status: 'Contato pendente',
    owner: dono,
    source: 'Prospecção ativa',
    notes: notaDoLead(lead, geradoEm),
    created_at: data,
    updated_at: data,
  };
  if (!linha.company) return { erro: 'sem nome de empresa' };
  if (!linha.contact_name) linha.contact_name = linha.company;
  const segmento = deduzirSegmento(lead);
  if (segmento) linha.segment = segmento;
  return { linha };
}

/* ------------------------------------------------------------------------ main */

(async () => {
  const argv = process.argv.slice(2);
  const gravar = argv.includes('--gravar');
  const opcaoDono = argv.find((a) => a.startsWith('--dono='));
  const dono = (opcaoDono ? opcaoDono.split('=')[1] : DONO_PADRAO).toLowerCase();

  if (!USUARIOS_VALIDOS.includes(dono)) {
    console.error(`--dono precisa ser um usuário que existe na tabela users: ${USUARIOS_VALIDOS.join(' ou ')}.`);
    process.exit(1);
  }

  const { geradoEm, alvoAntigo, lista } = carregarSnapshot();
  console.log(`Snapshot: ${path.relative(RAIZ, ARQUIVO_BACKUP)} — ${lista.length} leads, gerado em ${geradoEm} (alvo da migração da época: "${alvoAntigo}").`);

  const prontas = [];
  const comProblema = [];
  for (const lead of lista) {
    const { linha, erro } = paraLinha(lead, geradoEm, dono);
    if (erro) comProblema.push(`${lead.id}: ${erro}`);
    else prontas.push(linha);
  }

  const segmentos = {};
  for (const l of prontas) segmentos[l.segment || '(sem segmento)'] = (segmentos[l.segment || '(sem segmento)'] || 0) + 1;

  const cliente = criarCliente(carregarEnv());

  /* Só o que ainda não está na tabela — para não duplicar nem amassar edição. */
  const ids = prontas.map((l) => l.id);
  const existentes = new Set();
  for (let i = 0; i < ids.length; i += LINHAS_POR_LOTE) {
    const { data, error } = await cliente.from('leads').select('id').in('id', ids.slice(i, i + LINHAS_POR_LOTE));
    if (error) {
      console.error('Não consegui ler a tabela leads: ' + error.message);
      console.error('Se o erro fala de tabela ausente, rode backend/database/banco_novo.sql antes.');
      process.exit(1);
    }
    (data || []).forEach((r) => existentes.add(r.id));
  }
  const novas = prontas.filter((l) => !existentes.has(l.id));

  console.log(`Vão entrar ${novas.length} leads (owner="${dono}", status="Contato pendente", source="Prospecção ativa").`);
  if (existentes.size) console.log(`Já existem na tabela e ficam intactos: ${existentes.size}.`);
  if (comProblema.length) console.log(`Descartados: ${comProblema.length} — ${comProblema.join(' | ')}`);
  console.log('Segmento sugerido: ' + Object.entries(segmentos).map(([k, v]) => `${k}=${v}`).join(', '));

  console.log('\nPrimeiras 5 linhas como vão ficar:');
  novas.slice(0, 5).forEach((l) => console.log(`  ${l.id} | ${l.company} | ${l.contact_name} | ${l.created_at.slice(0, 10)}${l.segment ? ' | ' + l.segment : ''}`));

  if (!gravar) {
    console.log('\nDry-run: nada foi escrito. Rode com --gravar para jogar no banco.');
    return;
  }

  let total = 0;
  const falhas = [];
  for (let i = 0; i < novas.length; i += LINHAS_POR_LOTE) {
    const lote = novas.slice(i, i + LINHAS_POR_LOTE);
    const { data, error } = await cliente.from('leads').insert(lote).select('id');
    if (error) falhas.push(`lote ${i / LINHAS_POR_LOTE + 1}: ${error.message}`);
    else total += (data || []).length;
  }

  const { count } = await cliente.from('leads').select('id', { count: 'exact', head: true });
  console.log(`\nEscritos: ${total}. Leads na tabela agora: ${count}.`);
  if (falhas.length) console.log('Falhas:\n  ' + falhas.join('\n  '));
  if (total !== novas.length) console.log('Atenção: entrou menos do que o esperado — confira as falhas acima.');
})().catch((erro) => {
  console.error('Dei problema: ' + (erro && erro.message ? erro.message : erro));
  process.exit(1);
});
