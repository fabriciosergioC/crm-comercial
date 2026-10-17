"use strict";

/* Sugestões de resposta para o chat do CRM (Groq, camada gratuita).
   A chave fica no backend/.env — nunca no frontend, porque o navegador é público
   e qualquer um que abrir o site veria a chave no código-fonte. */

const crypto = require("node:crypto");

const { ApiError } = require("../middleware/errorHandler");
const { AUDIO_MARKER, isAudioContent } = require("./whatsapp/incomingAudioService");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
/* O llama-3.3-70b-versatile saiu do ar na Groq em 16/08/2026, junto com o
   llama-3.1-8b-instant. Os substitutos vigentes na camada gratuita são os
   gpt-oss. Se a Groq aposentar outro modelo, o pedido tenta o seguinte sozinho
   antes de mostrar qualquer aviso — ele não precisa mexer no .env. */
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

/* Nada de mandar a conversa inteira: quanto menos texto, mais rápido a Groq
   devolve e menos cota (tokens por minuto) cada clique gasta. O que importa está
   no fim: a última mensagem do cliente. */
const MAX_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 400;
const MAX_SUGGESTIONS = 4;
/* Modo resposta rápida: a sugestão tem que caber num bloco só, para ele ler e
   mandar sem editar. 500 caracteres virava parágrafo de análise — lento de ler e
   lento de gerar. */
const MAX_SUGGESTION_CHARS = 260;
const MAX_CONTEXT_CHARS = 3200;
/* Os gpt-oss "pensam" antes de escrever e esse pensamento é caro em tokens. Para
   resposta curta, esforço baixo de raciocínio: mesma leitura da mensagem, bem
   menos tempo. */
const REASONING_EFFORT = "low";
const MAX_OUTPUT_TOKENS = 600;
/* Mensagem que não tem texto (foto, áudio sem transcrição) não serve de âncora. */
const SEM_TEXTE_PATTERN = /^\[(Imagem|Vídeo|Áudio|Documento|Mensagem não textual)\]$/;

function readInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function suggestionCount() {
  return readInt("IA_SUGESTOES_QUANTIDADE", 3, 1, MAX_SUGGESTIONS);
}

function maxNewTokens() {
  return readInt("IA_SUGESTOES_MAX_TOKENS", MAX_OUTPUT_TOKENS, 120, 2000);
}

function modelId() {
  return modelCandidates()[0];
}

/* Ordem de tentativa: o modelo do .env primeiro, depois os vigentes padrão.
   Assim uma linha GROQ_MODEL antiga continua funcionando até o próximo clique. */
function modelCandidates() {
  const configured = String(process.env.GROQ_MODEL || "").trim();
  return [...new Set([configured, DEFAULT_MODEL, FALLBACK_MODEL].filter(Boolean))];
}

function clean(value, limit) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, limit);
}

/* O modelo só vê o que ele precisa: quem é o cliente, em que etapa está e o
   texto da conversa. Telefone, e-mail e campos internos ficam de fora. */

/* "Há quanto tempo ninguém fala" é o que separa uma retomada consultiva de uma
   cobrança. Só dá para saber isso pelo horário da última mensagem, então ele vai
   junto no contexto quando o front mandar; sem horário, a linha simplesmente não
   aparece e o resto continua funcionando. */
function lastMessageSignal(messages) {
  const ultima = messages[messages.length - 1];
  const raw = ultima?.timestamp || ultima?.date;
  const when = raw ? new Date(raw) : null;
  if (!when || Number.isNaN(when.getTime())) return "";
  const dias = Math.floor((Date.now() - when.getTime()) / 86400000);
  const tempo = dias <= 0 ? "hoje" : dias === 1 ? "ontem" : `há ${dias} dias`;
  const quem = ultima.direction === "outgoing" ? "Erick" : "o cliente";
  const esperado = ultima.direction === "outgoing"
    ? `o cliente ainda não respondeu (${tempo})`
    : `a bola está com o Erick (${tempo} que o cliente escreveu)`;
  return `Última mensagem: enviada por ${quem}, ${esperado}.`;
}

/* A âncora é a última mensagem que tem TEXTE de verdade. Uma foto ou um áudio
   sem transcrição no fim da conversa não pode virar "responda isso", porque o
   modelo inventaria conteúdo a partir de um colchete. */
function mensagemAncora(lista) {
  for (let i = lista.length - 1; i >= 0; i--) {
    const mensagem = lista[i];
    const texto = clean(mensagem?.content, MAX_MESSAGE_CHARS);
    if (texto && !SEM_TEXTE_PATTERN.test(texto)) return { texto, mensagem, index: i };
  }
  return null;
}

function buildContext({ lead, conversation, senderName }) {
  const listaOriginal = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const lista = listaOriginal.filter(message => clean(message?.content, MAX_MESSAGE_CHARS));
  const ancora = mensagemAncora(lista);
  const visiveis = lista.slice(-MAX_MESSAGES);

  const messages = visiveis
    /* O áudio que o cliente manda chega como texto transcrito com o marcador
       "🎧 " na frente. Para o modelo, o que importa é saber que aquilo foi FALA
       (dita, não digitada): o tom costuma ser mais solto e cheio de detalhes. */
    .map(message => {
      const conteudo = clean(message.content, MAX_MESSAGE_CHARS);
      const quem = message.direction === "outgoing" ? "Erick" : "Cliente";
      if (isAudioContent(conteudo)) {
        return `${quem} (mandou áudio, transcrito): ${conteudo.slice(AUDIO_MARKER.length)}`;
      }
      if (SEM_TEXTE_PATTERN.test(conteudo)) return `${quem}: ${conteudo} (sem texto)`;
      return `${quem}: ${conteudo}`;
    })
    .join("\n");

  const etapas = [];
  if (clean(lead?.status, 40)) etapas.push(`etapa comercial "${clean(lead.status, 40)}"`);
  if (clean(conversation?.status, 40)) etapas.push(`status da conversa "${clean(conversation.status, 40)}"`);

  const jaFalou = lista.some(message => message.direction === "outgoing");
  const linhas = [
    `Nome do contato: ${clean(lead?.contactName || conversation?.contact?.name, 80) || "desconhecido"}`,
    `Empresa: ${clean(lead?.company || conversation?.contact?.company, 80) || "desconhecida"}`,
    `Ramo do negócio: ${clean(lead?.segment, 40) || "não informado"}`,
    `Cidade: ${clean(lead?.city, 40) || "não informada"}`,
    `Momento do atendimento: ${etapas.join(" e ") || "não informado"}`,
    `O Erick já escreveu nesta conversa? ${jaFalou ? "sim" : "não — é a primeira vez que ele responde"}`,
    lastMessageSignal(lista),
    /* A anotação é o que o Erick escreveu sobre aquele lead — é o melhor sinal
       do que ele já descobriu, e por isso vai junto (só texto, sem dados de
       contato). */
    `Anotação do Erick sobre este lead: ${clean(lead?.notes, 220) || "(nenhuma)"}`,
    `Últimas mensagens:\n${messages || "(sem mensagens registradas)"}`,
  ].filter(Boolean);
  if (senderName) linhas.push(`Quem escreve: ${clean(senderName, 60)}`);

  /* O pedido de verdade vem por último, porque é o que segura o modelo na
     mensagem certa: sem esta linha ele escrevia sobre a barbearia inteira em vez
     de responder o "boa tarde, assim que possível eu aviso ele". */
  if (ancora) {
    const quem = ancora.mensagem.direction === "outgoing" ? "do Erick (última dita na conversa)" : "do CLIENTE (última dita na conversa)";
    linhas.push(`>>> MENSAGEM QUE VOCÊ RESONDE — ${quem}: "${ancora.texto.slice(0, 320)}"`);
    /* Se depois dessa fala só chegou foto, vídeo ou áudio sem transcrição, o
       modelo precisa saber: é aquilo que o cliente está esperando ver respondido,
       e ele não pode fingir que não recebeu. */
    const depois = lista.slice(ancora.index + 1);
    if (depois.length) {
      const oQueChegou = depois.map(m => `${m.direction === "outgoing" ? "o Erick" : "o cliente"} mandou ${clean(m.content, 30)}`).join(", ");
      linhas.push(`>>> Depois dessa fala, ${oQueChegou} — mensagem sem texto: não invente o conteúdo, responda o que dá para saber e, se precisar, pergunte o que está na imagem.`);
    }
    const ancoraEraDoCliente = ancora.mensagem.direction !== "outgoing";
    if (ancoraEraDoCliente) {
      linhas.push(">>> É uma resposta a ELA: a primeira frase já reage ao que ele disse, com as palavras dele. Nada de retomar o assunto geral da empresa, nada de cumprimento de abertura, nada de oferta.");
    } else {
      linhas.push(">>> O Erick falou por último e o cliente ainda não respondeu: a sugestão é um passo curto da vez dele (combinado, prazo ou uma pergunta só), sem cobrar retorno e sem repetir o que ele já disse.");
    }
    /* O erro mais comum de resposta pronta no WhatsApp é dar "Oi!" no meio de um
       papo que já vai na quinta mensagem. */
    linhas.push(jaFalou
      ? ">>> A conversa já andou: nenhuma sugestão começa com 'Oi', 'Olá', 'Bom dia' ou nome do cliente."
      : ">>> O Erick ainda não disse nada nesta conversa: pode abrir com 'Oi, [primeiro nome]!'.");
  }
  return linhas.join("\n").slice(0, MAX_CONTEXT_CHARS);
}

/* A linha do meio muda conforme a oferta escrita no .env: sem IA_OFERTA, o
   modelo só conhece o produto genérico; com ela, segue a venda do momento. */
function systemPrompt() {
  const oferta = clean(process.env.IA_OFERTA || "", 300);
  const linhas = [
    "Você escreve no WhatsApp como o analista das conversas do Erick Santos. Ele presta serviços de tecnologia",
    "para pequenos e médios negócios da região dele, e o seu papel é ler a conversa antes de escrever:",
    "entender a dor real do cliente, dar uma opinião útil e orientar, sem nunca forçar uma resposta.",
    "",
    "QUEM VOCÊ É NA CONVERSA: um consultor que já viu esse tipo de negócio funcionando por dentro. Você não",
    "empurra produto; você observa a rotina do cliente, explica o que costuma dar problema ali e mostra um",
    "caminho. A simpatia vem da competência, não de frases prontas.",
    "",
    "O QUE ELE VENDE (use só isto, sem inventar outro produto):",
    "- Página/site em que o cliente da empresa conhece o serviço e cai direto no WhatsApp da empresa para pedir.",
    "- Organização de pedidos e anotações que hoje chegam por mensagem e são digitados de novo.",
    "- Automação e melhoria de atendimento com tecnologia simples de usar.",
    "- O ganho que ele oferece é sempre o mesmo: atendimento mais rápido e mais pedido vendido para aquela empresa.",
  ];
  if (oferta) {
    linhas.push("- Oferta que ele está passando agora (use exatamente isto, sem inventar valor): " + oferta);
  }
  linhas.push(
    "",
    "PRIMEIRO ANALISE A CONVERSA (isto fica na sua cabeça; só a mensagem final sai):",
    "1. Leia a linha '>>> MENSAGEM QUE VOCÊ RESONDE': é exatamente aquilo que você responde agora.",
    "2. O que ele escreveu (ou ditou) ali, e o que ele deixou de escrever.",
    "3. Como ele está: ocupado, em dúvida, com medo de investir, comparando com outra opção, ou só esperando",
    "   alguém explicar melhor. A leitura certa muda o tom da resposta.",
    "4. Só então escreva: a análise não vai no texto, ela só muda o que você responde.",
    "",
    "OBJETIVO DA MENSAGEM (em toda sugestão, nesta ordem):",
    "1. Reagir ao que ele acabou de dizer, com as palavras dele — é isso que faz a resposta parecer imediata.",
    "2. Somar uma leitura curta do que costuma acontecer num negócio como o dele.",
    "3. Fechar com um próximo passo simples, ou uma pergunta só.",
    "",
    "COMO ABORDAR (o estilo é de consultor que analisa, não de vendedor que pressiona):",
    "- Responda primeiro; o serviço aparece depois, e só se couber naquela resposta.",
    "- Opine com humildade: 'pelo que você contou', 'no que costuma acontecer aí', 'uma coisa que costuma escapar'.",
    "- Oriente de verdade: um caminho, um detalhe para olhar, um erro comum do ramo daquela cidade. Isso vale",
    "  mesmo se ele fechar com outra empresa.",
    "- Evite frase direta demais ('tem interesse?', 'me manda o endereço', 'vamos fechar?'). Primeiro mostre que",
    "  entendeu; o pedido vem por último, se vier.",
    "- Nada de texto de anúncio: 'não perca', 'últimas vagas', 'transforme seu negócio', 'potencialize'.",
    "- Se ele já recebeu demonstração, pergunte o que faria sentido ajustar para a rotina dele, e não se ele vai comprar.",
    "",
    "ÂNGULO POR MOMENTO DO ATENDIMENTO (campo 'Momento do atendimento' acima):",
    "- Contato pendente / Novo: entender a rotina antes de oferecer qualquer coisa. Observação curta + pergunta fácil.",
    "- Atendimento iniciado: aprofundar a dor. Perguntar como aquilo é feito hoje, sem oferta.",
    "- Aguardando resposta / silêncio: ver a regra de silêncio abaixo. Nunca cobrar.",
    "- Respondido: retomar exatamente o ponto que ele levantou, mostrar que entendeu, e ampliar com uma leitura",
    "  do problema dele antes de qualquer passo.",
    "- Demo Enviada / Interessado: opinar sobre o que ele viu, ajustar à realidade do ramo e marcar uma conversa",
    "  rápida (áudio, ligação ou presencial).",
    "- Proposta enviada / Negociação: destravar a objeção com orientação concreta (o que costuma pesar numa hora",
    "  dessas, como testar antes), reforçar o ganho que ele já viu e combinar um próximo passo com dia. Sem ultimato.",
    "- Fechado: pós-venda. Pedir com calma o que falta para começar (nome do serviço, fotos, número de WhatsApp).",
    "- Perdido / Resolvido / Arquivado / Cancelado: encerrar bem, deixar uma dica útil e a porta aberta.",
    "",
    "QUANDO ELE FALA POR ÁUDIO (linha 'Cliente (mandou áudio, transcrito)'):",
    "- O CRM transcreve a nota de voz dele e mostra o texto para você. Trate o conteúdo como se ele tivesse",
    "  escrito: na fala a frase sai solta, pela metade, e é ali que aparece a objeção verdadeira (medo de",
    "  investir, comparação com outra empresa, receio de atrapalhar a equipe). Ouça o tom, não só a palavra.",
    "- Você pode retomar o que ele contou no áudio ('no seu áudio você comentou que...'); ele mandou o áudio,",
    "  então sabe que você ouviu. Nunca diga que é IA, que transcreve ou que a resposta foi automática.",
    "- Se a linha não trouxer texto (transcrição indisponível), NÃO invente o que ele falou: fale do que está",
    "  claro na conversa e faça uma pergunta que já serve para ele repetir o ponto principal.",
    "- Responda primeiro ao que ele disse no áudio; oferta só depois de mostrar que entendeu.",
    "",
    "REGRAS DA MENSAGEM DE SUGESTÃO (resposta rápida de WhatsApp, não texto de e-mail):",
    "- UM bloco só, sem linha em branco no meio: no máximo 2 frases e ~180 caracteres. Passou disso, corte —",
    "  resposta longa ele não envia, e ainda demora mais para chegar.",
    "- Sem saudação de abertura quando a conversa já está andando: vá direto ao que ele disse. Cumprimento de",
    "  primeira vez ('Oi, Juliana! 😊') só quando o campo 'Última mensagem' mostra que o Erick ainda não falou.",
    "- No máximo uma pergunta, no fim, e apenas se ela fizer a conversa andar. Sem pergunta está ótimo.",
    "- Pode destacar uma frase com asteriscos no fim (padrão do WhatsApp). Nada de markdown, título ou assinatura.",
    "- No máximo um emoji na mensagem inteira. Fala como pessoa: 'você', 'a sua empresa'.",
    "- As sugestões mudam só o ângulo, nunca o tamanho: uma responde direto, uma responde e orienta, uma responde e pergunta.",
    "",
    "QUANDO O CLIENTE SUMIU (campo 'Última mensagem' diz 'o cliente ainda não respondeu'):",
    "- Jamais cobre resposta e jamais mencione o silêncio: nada de 'vi que você não respondeu', 'quando puder me",
    "  dê um retorno', 'só passando para lembrar'.",
    "- Volte com uma coisa só, curta, que vale por si: um detalhe da rotina dele, um erro comum do ramo, algo que",
    "  ele pode conferir hoje em cinco minutos. Quanto mais dias sem falar, menos pedido de retorno.",
    "- Se a bola está com o Erick ('a bola está com o Erick'), não invente assunto novo: amplie em uma frase o que",
    "  ele disse por último, ou combine o próximo passo com dia.",
    "",
    "COMO O ERICK ESCREVE (imitar o tamanho e o ritmo, nunca o conteúdo):",
    "- Assim, de verdade, são as mensagens dele: \"Fecho sim, te mando amanhã antes do meio-dia 👍\", \"Entendi! A",
    "  questão aí é quem anota o pedido no balcão, ne?\", \"Tranquilo. Quando quiser, eu passo aí e mostro em 10",
    "  minutos como ficaria na sua rotina. Serve terça ou quarta?\"",
    "",
    "NUNCA, EM HIPÓTESE ALGUMA:",
    "- Invente preço, prazo, desconto, parcelamento, nome de cliente, número de vendas ou resultado.",
    "- Cite percentual, média ou promessa de resultado ('reduz em até 30%', 'vende 2x mais'). Ele não tem esses",
    "  números: fale do que costuma acontecer, sem cifra.",
    "- Afirme nada sobre a empresa que não esteja no contexto; na dúvida, pergunte em vez de supor.",
    "- Prometa link, arquivo, áudio, vídeo ou demonstração que o Erick não tenha dito que vai mandar.",
    "- Diga que é inteligência artificial, assistente ou que a resposta foi automática.",
    "- Cobre resposta, faça cobrança moral ('vi que você não respondeu') ou pressione com escassez falsa.",
    "- Faça mais de uma pergunta na mesma sugestão; a segunda pergunta sempre sobra, corte ela.",
    "- Repita a mesma oferta ou o mesmo pedido de retorno de uma mensagem anterior.",
    "- Fale do produto antes de falar do problema do cliente.",
    "- Escreva telefone, e-mail ou endereço no texto: o CRM já cuida desses dados.",
    "",
    "As três sugestões respondem A MESMA mensagem do cliente, mudando só o ângulo:",
    "uma só confirma/resolve o que ele perguntou; uma responde e aponta o que costuma escapar no ramo dele;",
    "uma responde e faz a única pergunta que faz a conversa andar. Todas curtas.",
    "",
    'Responda SOMENTE com JSON válido no formato {"sugestoes":["texto","texto","texto"]}.',
  );
  return linhas.join("\n");
}

/* Recusas educadas do modelo não podem virar mensagem para o cliente. */
const RECUSA_PATTERN = /^(desculpe|desculsa|desculpa|n[ãa]o (tenho|posso|consigo)|sem sugest|como (assistente|modelo|ia)|n[ãa]o posso ajudar)/i;

/* Diferente do clean(): o WhatsApp do Erick é feito de blocos curtos separados por
   linha em branco, e o clean colapsaria tudo em uma linha só. Aqui a quebra de
   parágrafo é preservada, e o corte por tamanho cai sempre no fim de uma frase. */
function tidyMessage(value, limit) {
  const texto = String(value == null ? "" : value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map(linha => linha.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (texto.length <= limit) return texto;
  const ateLimite = texto.slice(0, limit);
  const fimDeFrase = Math.max(
    ateLimite.lastIndexOf(". "),
    ateLimite.lastIndexOf("? "),
    ateLimite.lastIndexOf("! "),
    ateLimite.lastIndexOf(".*"),
    ateLimite.lastIndexOf("?*"),
  );
  const fimDeBloco = ateLimite.lastIndexOf("\n\n");
  const ponto = Math.max(fimDeFrase, fimDeBloco);
  if (ponto < 120) return ateLimite.trim();
  return fimDeBloco === ponto ? ateLimite.slice(0, ponto).trim() : ateLimite.slice(0, ponto + 1).trim();
}

/* O Groq às vezes embrulha o JSON em crases ou texto extra; então tenta JSON e,
   se falhar, tira as linhas que parecem mensagem. */
function extractSuggestions(rawContent, limit) {
  const raw = String(rawContent || "").trim();
  const found = [];
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
      const list = Array.isArray(parsed?.sugestoes) ? parsed.sugestoes : Array.isArray(parsed) ? parsed : [];
      list.forEach(item => {
        const text = tidyMessage(item, MAX_SUGGESTION_CHARS);
        if (text && !RECUSA_PATTERN.test(text)) found.push(text);
      });
    } catch (_) { /* cai no leitor de linhas abaixo */ }
  }
  if (!found.some(Boolean)) {
    raw
      .replace(/```/g, "")
      .split(/\r?\n/)
      .map(line => line.replace(/^\s*(?:[-*•]|\d+[).])\s*/, "").replace(/^["']|["']$/g, ""))
      .forEach(line => {
        const text = clean(line, MAX_SUGGESTION_CHARS);
        if (text && text.length > 8 && !/[{}]/.test(text) && !RECUSA_PATTERN.test(text)) found.push(text);
      });
    /* Uma linha solta costuma ser recusa do modelo ("desculpe, não posso..."),
       não sugestão. O leitor de linhas só vale quando encontra 2 ou mais. */
    if (found.length < Math.min(2, limit)) found.length = 0;
  }
  const unique = [];
  found.forEach(text => {
    if (text && !unique.some(other => other.toLocaleLowerCase("pt-BR") === text.toLocaleLowerCase("pt-BR"))) unique.push(text);
  });
  return unique.slice(0, limit);
}

/* Só lê código/status; o corpo bruto do provedor pode trazer detalhes da conta. */
async function readProviderDetail(response) {
  try {
    const body = await response.json();
    const error = body?.error;
    return {
      code: String(error?.code || error?.type || error || "").toLowerCase(),
      message: clean(error?.message || error || "", 200).toLowerCase(),
    };
  } catch (_) {
    return { code: "", message: "" };
  }
}

/* A Groq aposenta modelos sem avisar o nosso .env. Quando o modelo pedido não
   existe mais, isto detecta o sinal e o laço abaixo tenta os modelos vigentes. */
function isMissingModel(httpStatus, detail) {
  const signals = `${detail.code} ${detail.message}`;
  return signals.includes("model_decommissioned")
    || signals.includes("model_not_found")
    || signals.includes("unknown model")
    || (httpStatus === 404 && signals.includes("model"));
}

function providerFailure(httpStatus, detail, model) {
  const signals = `${detail.code} ${detail.message}`;
  if (httpStatus === 401) {
    return [503, "A GROQ_API_KEY do backend não foi aceita. Abra console.groq.com → API Keys, copie a chave que começa com gsk_ e cole em backend/.env. Depois reinicie o run-crm.bat."];
  }
  if (httpStatus === 403 || signals.includes("permission")) {
    return [503, "A chave da Groq existe, mas a conta ainda não tem acesso à API de inferência. Entre no console.groq.com uma vez com o login usado e tente de novo."];
  }
  if (httpStatus === 429) {
    return [429, "A cota gratuita da Groq chegou ao limite de agora (são cerca de 30 pedidos por minuto e 1.000 por dia). Espere um minuto e clique outra vez."];
  }
  if (isMissingModel(httpStatus, detail)) {
    return [503, `O modelo ${model} não está mais disponível na Groq. Troque a linha GROQ_MODEL no backend/.env por um modelo vigente (veja console.groq.com → Model Catalog).`];
  }
  if (httpStatus === 400) {
    return [400, "A Groq recusou o pedido. Abra a conversa com o WhatsApp conectado e tente novamente; se persistir, reduza o histórico da conversa."];
  }
  if (httpStatus >= 500) {
    return [502, "A Groq está indisponível agora (serviço deles, não do seu CRM). Tente daqui a pouco."];
  }
  return [502, `A inteligência artificial não conseguiu responder (o provedor respondeu HTTP ${httpStatus}).`];
}

/* Um pedido à Groq com um modelo específico. Devolve { missingModel: true }
   quando o motivo da recusa é o próprio modelo, para quem chamar tentar o próximo. */
async function askGroq(apiKey, model, context, opcoes = {}) {
  let response;
  const corpo = {
    model,
    temperature: 0.7,
    max_tokens: maxNewTokens(),
    messages: [
      { role: "system", content: systemPrompt() },
      { role: "user", content: context },
    ],
  };
  /* Resposta curta não precisa de cadeia de pensamento longa: o esforço baixo corta
     os tokens de raciocínio (que também entram no max_tokens) e devolve a sugestão
     em bem menos tempo. A Groq aceita `reasoning_effort` nos gpt-oss; se um dia
     recusar, a chamada abaixo refaz o pedido sem essa linha. */
  if (!opcoes.semReasoningEffort) corpo.reasoning_effort = REASONING_EFFORT;
  try {
    response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new ApiError(504, "A IA demorou demais para responder. Tente novamente.");
    }
    throw new ApiError(502, "Não foi possível conectar à Groq. Confira se este computador está ligado à internet.");
  }

  if (!response.ok) {
    const detail = await readProviderDetail(response);
    if (isMissingModel(response.status, detail)) return { missingModel: true };
    /* 400 com reclamação de parâmetro = a Groq mudou o que aceita. Tenta de novo
       sem o raciocínio baixo, que é o único luxo deste pedido. */
    if (response.status === 400 && /reasoning|effort/i.test(`${detail.code} ${detail.message}`)) {
      return askGroq(apiKey, model, context, { semReasoningEffort: true });
    }
    throw new ApiError(...providerFailure(response.status, detail, model));
  }

  let content = "";
  try {
    const body = await response.json();
    content = body?.choices?.[0]?.message?.content || "";
  } catch (_) {
    throw new ApiError(502, "A Groq respondeu sem texto utilizável.");
  }
  return { content };
}

/* A cota grátis da Groq é apertada (~30 pedidos por minuto) e a conversa costuma
   ser aberta mais de uma vez seguida. Então a mesma última mensagem gera uma
   chamada só: a resposta fica em memória enquanto a conversa não mudar. Muda
   qualquer coisa (chegou mensagem nova, mudou etapa, mudou quem escreve) e a
   próxima chamada cai fora do cache. */
const CACHE_MAXIMO = 60;
const sugestoesEmCache = new Map();
const pedidosEmAndamento = new Map();

function cacheMinutos() {
  return readInt("IA_SUGESTOES_CACHE_MINUTOS", 30, 0, 720);
}

function chaveDoCache(payload) {
  const conv = (payload && payload.conversation) || {};
  const lista = Array.isArray(conv.messages) ? conv.messages : [];
  const ultima = lista[lista.length - 1] || {};
  const partes = [
    (payload && payload.conversationId) || conv.id || "",
    lista.length,
    ultima.timestamp || ultima.date || "",
    clean(ultima.content, 200),
    conv.status || "",
    (payload && payload.lead && payload.lead.status) || "",
    (payload && payload.senderName) || "",
    suggestionCount(),
  ].join("|");
  return crypto.createHash("sha1").update(partes).digest("hex");
}

function lerCache(chave) {
  const minutos = cacheMinutos();
  if (!minutos) return null;
  const guardado = sugestoesEmCache.get(chave);
  if (!guardado) return null;
  if (Date.now() - guardado.at > minutos * 60000) {
    sugestoesEmCache.delete(chave);
    return null;
  }
  return guardado.result;
}

function gravarCache(chave, result) {
  if (!cacheMinutos()) return;
  if (sugestoesEmCache.size >= CACHE_MAXIMO) {
    /* Map guarda a ordem de inclusão: o primeiro é o mais velho. */
    const maisVelho = sugestoesEmCache.keys().next().value;
    if (maisVelho !== undefined) sugestoesEmCache.delete(maisVelho);
  }
  sugestoesEmCache.set(chave, { at: Date.now(), result });
}

async function gerar(payload) {
  const apiKey = String(process.env.GROQ_API_KEY || "").trim();
  if (!apiKey) {
    throw new ApiError(503, "Ative a IA: abra console.groq.com, crie a chave gratuita (API Keys) e cole o valor de GROQ_API_KEY no arquivo backend\\.env. Depois feche e rode o run-crm.bat de novo.");
  }

  const limit = suggestionCount();
  const context = buildContext(payload || {});
  if (!context.includes("Erick:") && !context.includes("Cliente:")) {
    throw new ApiError(400, "Abre uma conversa com mensagens para a IA sugerir respostas.");
  }

  const models = modelCandidates();
  for (const model of models) {
    const answer = await askGroq(apiKey, model, context);
    if (answer.missingModel) continue;
    const sugestoes = extractSuggestions(answer.content, limit);
    if (!sugestoes.length) {
      throw new ApiError(502, "A IA não devolveu sugestões utilizáveis. Clique de novo em Sugerir resposta.");
    }
    return { model, suggestions: sugestoes };
  }

  throw new ApiError(503, `Nenhum modelo disponível na sua conta Groq conseguiu responder (${models.join(", ")}). Troque a linha GROQ_MODEL no arquivo backend\\.env por um modelo vigente do catálogo (console.groq.com → Models) e rode o run-crm.bat de novo.`);
}

async function generateReplySuggestions(payload) {
  const chave = chaveDoCache(payload || {});
  const guardado = lerCache(chave);
  if (guardado) return { ...guardado, cacheado: true };

  /* Dois pedidos iguais ao mesmo tempo (clique duplo, ou a tela chamando sozinha
     enquanto ele clica) viram UMA chamada à Groq: a segunda entra na mesma
     promessa em vez de gastar a cota. */
  const emAndamento = pedidosEmAndamento.get(chave);
  if (emAndamento) return emAndamento.then(result => ({ ...result, cacheado: true }));

  const promessa = gerar(payload).then(result => {
    gravarCache(chave, result);
    return result;
  }).finally(() => pedidosEmAndamento.delete(chave));
  pedidosEmAndamento.set(chave, promessa);
  return promessa;
}

/* O que a interface pode mostrar sem expor chave nem cota da conta. */
function aiInfo() {
  return {
    enabled: Boolean(String(process.env.GROQ_API_KEY || "").trim()),
    model: modelId(),
    quantity: suggestionCount(),
    cacheMinutes: cacheMinutos(),
  };
}

module.exports = { generateReplySuggestions, aiInfo, _internos: { buildContext, systemPrompt, extractSuggestions, mensagemAncora } };
