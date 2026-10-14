"use strict";

/* Sugestões de resposta para o chat do CRM (Groq, camada gratuita).
   A chave fica no backend/.env — nunca no frontend, porque o navegador é público
   e qualquer um que abrir o site veria a chave no código-fonte. */

const { ApiError } = require("../middleware/errorHandler");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
/* O llama-3.3-70b-versatile saiu do ar na Groq em 16/08/2026, junto com o
   llama-3.1-8b-instant. Os substitutos vigentes na camada gratuita são os
   gpt-oss. Se a Groq aposentar outro modelo, o pedido tenta o seguinte sozinho
   antes de mostrar qualquer aviso — ele não precisa mexer no .env. */
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";

/* Nada de mandar a conversa inteira: as últimas mensagens bastam e mantêm o uso
   dentro da cota gratuita (200 mil tokens por dia). */
const MAX_MESSAGES = 14;
const MAX_MESSAGE_CHARS = 700;
const MAX_SUGGESTIONS = 4;
/* O Erick escreve em blocos curtos separados por linha em branco; uma mensagem
   completa dele passa de 500 caracteres, então o teto precisa sobrar. */
const MAX_SUGGESTION_CHARS = 800;

function readInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function suggestionCount() {
  return readInt("IA_SUGESTOES_QUANTIDADE", 3, 1, MAX_SUGGESTIONS);
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

function buildContext({ lead, conversation, senderName }) {
  const lista = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const messages = lista
    .filter(message => clean(message?.content, MAX_MESSAGE_CHARS))
    .slice(-MAX_MESSAGES)
    .map(message => `${message.direction === "outgoing" ? "Erick" : "Cliente"}: ${clean(message.content, MAX_MESSAGE_CHARS)}`)
    .join("\n");

  const etapas = [];
  if (clean(lead?.status, 40)) etapas.push(`etapa comercial "${clean(lead.status, 40)}"`);
  if (clean(conversation?.status, 40)) etapas.push(`status da conversa "${clean(conversation.status, 40)}"`);

  const linhas = [
    `Nome do contato: ${clean(lead?.contactName || conversation?.contact?.name, 80) || "desconhecido"}`,
    `Empresa: ${clean(lead?.company || conversation?.contact?.company, 80) || "desconhecida"}`,
    `Ramo do negócio: ${clean(lead?.segment, 40) || "não informado"}`,
    `Cidade: ${clean(lead?.city, 40) || "não informada"}`,
    `Momento do atendimento: ${etapas.join(" e ") || "não informado"}`,
    lastMessageSignal(lista),
    /* A anotação é o que o Erick escreveu sobre aquele lead — é o melhor sinal
       do que ele já descobriu, e por isso vai junto (só texto, sem dados de
       contato). */
    `Anotação do Erick sobre este lead: ${clean(lead?.notes, 220) || "(nenhuma)"}`,
    `Últimas mensagens:\n${messages || "(sem mensagens registradas)"}`,
  ].filter(Boolean);
  if (senderName) linhas.push(`Quem escreve: ${clean(senderName, 60)}`);
  return linhas.join("\n").slice(0, 6000);
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
    "1. O que o cliente escreveu, e o que ele deixou de escrever.",
    "2. Qual é a dor por trás disso na rotina da empresa dele (pedido que se perde, anotação em papel,",
    "   demora para responder quem pediu orçamento, agenda embaralhada, entrega sem confirmação).",
    "3. Como ele está em relação ao atendimento: ocupado, em dúvida, com medo de investir, comparando com",
    "   outra opção, ou só esperando alguém explicar melhor. A leitura certa muda o tom da mensagem.",
    "4. O que ele ainda não entendeu, e que orientação serviria mesmo que ele nunca comprasse nada.",
    "5. Só então escolha o ângulo: você vai falar do problema dele, não do serviço.",
    "",
    "OBJETIVO DA MENSAGEM (em toda sugestão, nesta ordem):",
    "1. Mostrar que você entendeu a situação dele — retomar o que ele falou, com as palavras dele.",
    "2. Dar uma leitura do problema: o que costuma acontecer num negócio como o dele, o que costuma escapar.",
    "3. Deixar uma orientação que já sirva de graça, sem esperar nada em troca.",
    "4. Terminar com uma pergunta aberta que convide a conversa, nunca com cobrança de resposta.",
    "",
    "COMO ABORDAR (o estilo é de consultor que analisa, não de vendedor que pressiona):",
    "- Comece sempre pelo problema ou pela rotina da empresa; o serviço aparece depois, como consequência.",
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
    "REGRAS DA MENSAGEM DE SUGESTÃO:",
    "- Blocos curtos separados por linha em branco; de 1 a 4 blocos; no máximo ~500 caracteres.",
    "- O primeiro bloco é de acolhimento, com o primeiro nome quando o contexto trouxer um ('Oi, Juliana! 😊',",
    "  'Olá, bom dia, Sérgio!'); sem nome, abra sem vocativo. Uma frase só, e siga para o conteúdo.",
    "- Depois dos blocos, a pergunta aberta no fim do corpo da mensagem, EXATAMENTE UMA por sugestão; se vier",
    "  uma segunda pergunta na cabeça, corte a segunda. Preferir pergunta que não se responda com sim ou não:",
    "  'como vocês fazem isso hoje?', 'o que mais atrapalha aí?'.",
    "- Pode destacar uma frase com asteriscos no fim (padrão do WhatsApp). Nada de markdown, título ou assinatura.",
    "- No máximo um emoji na mensagem inteira. Fala como pessoa: 'você', 'a sua empresa'.",
    "",
    "QUANDO O CLIENTE SUMIU (campo 'Última mensagem' diz 'o cliente ainda não respondeu'):",
    "- Jamais cobre resposta e jamais mencione o silêncio: nada de 'vi que você não respondeu', 'quando puder me",
    "  dê um retorno', 'só passando para lembrar'.",
    "- Volte com conteúdo que vale por si: uma observação sobre a rotina dele, um problema comum do ramo, um",
    "  detalhe que ele pode conferir hoje em poucos minutos e que já ajuda.",
    "- Quanto mais dias sem falar, mais a mensagem precisa ser entrega de valor e menos pedido de retorno.",
    "- Se quiser reconhecer a correria, faça isso em meia frase e siga para o conteúdo.",
    "- Se a bola está com o Erick ('a bola está com o Erick'), não invente assunto novo: responda o que ele",
    "  perguntou e só depois amplie.",
    "",
    "COMO O ERICK ESCREVE (imitar o estilo dele, não o texto de um anúncio):",
    "- Exemplo real do ritmo dele (copie o jeito, nunca o conteúdo): \"Oi, [nome]! 😊\n\nVocê comentou que os",
    "  pedidos chegam por mensagem e às vezes alguém anota e acaba não chamando de volta.\n\nNo que costuma",
    "  acontecer em padaria e restaurante, é justamente nessa hora que o pedido se perde: a pessoa anota no",
    "  papel, atende outro balcão e depois não lembra quem pediu.\n\nAntes de qualquer coisa, vale olhar quantos",
    "  pedidos saem por dia e quantos deles nunca voltaram.\n\nComo vocês organizam isso hoje?\"",
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
    "As sugestões precisam ser diferentes entre si, cada uma com um ângulo de análise:",
    "uma que diagnostica o problema e orienta; uma que observa algo típico do ramo daquele cliente;",
    "e uma curta que só quer entender melhor como ele resolve isso hoje.",
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
async function askGroq(apiKey, model, context) {
  let response;
  try {
    response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        /* Os gpt-oss gastam parte do orçamento pensando antes de escrever, e cada
           sugestão do Erick tem vários blocos: 700 tokens dava mensagem cortada. */
        max_tokens: 1800,
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: context },
        ],
      }),
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

async function generateReplySuggestions(payload) {
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
    const suggestions = extractSuggestions(answer.content, limit);
    if (!suggestions.length) {
      throw new ApiError(502, "A IA não devolveu sugestões utilizáveis. Clique de novo em Sugerir resposta.");
    }
    return { model, suggestions };
  }

  throw new ApiError(503, `Nenhum modelo disponível na sua conta Groq conseguiu responder (${models.join(", ")}). Troque a linha GROQ_MODEL no arquivo backend\\.env por um modelo vigente do catálogo (console.groq.com → Models) e rode o run-crm.bat de novo.`);
}

/* O que a interface pode mostrar sem expor chave nem cota da conta. */
function aiInfo() {
  return {
    enabled: Boolean(String(process.env.GROQ_API_KEY || "").trim()),
    model: modelId(),
    quantity: suggestionCount(),
  };
}

module.exports = { generateReplySuggestions, aiInfo };
