"use strict";

/* Ciclo de vida operacional da conversa de WhatsApp.
   Novo ............... cliente acabou de entrar em contato (sem ação do atendente)
   Atendimento iniciado  atendente está conversando com o cliente
   Aguardando resposta  atendente respondeu e espera o retorno do cliente
   Respondido ........ cliente respondeu e precisa de ação do atendente
   Demo Enviada ....... demonstração enviada ao cliente
   Resolvido .......... atendimento concluído
   Cancelado .......... encerrado sem solução
   Arquivado .......... conversa retirada da fila
   As transições automáticas (mensagem recebida/enviada/abertura) convivem com a
   escolha manual do atendente (Resolvido/Cancelado/Arquivado/Atendimento iniciado). */

const STATUSES = [
  "Novo",
  "Atendimento iniciado",
  "Aguardando resposta",
  "Respondido",
  "Demo Enviada",
  "Resolvido",
  "Cancelado",
  "Arquivado",
];

const STATUS_SET = new Set(STATUSES);

/* Rótulos usados antes deste ciclo de vida (inclusive os anteriores a esta
   renomeação); mapeados para o equivalente atual. */
const LEGACY = {
  "Em atendimento": "Atendimento iniciado",
  "Aguardando cliente": "Aguardando resposta",
  "Aguardando atendente": "Respondido",
};

const DEFAULT_STATUS = "Novo";

function isValid(status) {
  return STATUS_SET.has(status);
}

/* Garante um status válido: converte legado, aceita vazio como padrão. */
function normalize(status) {
  if (!status) return DEFAULT_STATUS;
  if (STATUS_SET.has(status)) return status;
  if (LEGACY[status]) return LEGACY[status];
  return DEFAULT_STATUS;
}

/* Mensagem recebida: se o atendente ainda não agiu (Novo), continua Novo;
   em qualquer outro caso (inclusive Resolvido/Cancelado/Arquivado, que são
   reabertos) a conversa passa a precisar de ação do atendente. */
function nextOnIncoming(current) {
  const status = normalize(current);
  return status === "Novo" ? "Novo" : "Respondido";
}

/* Atendente abriu/está vendo a conversa: Novo e "Respondido" viram
   "Atendimento iniciado". Estados manuais (Resolvido/Cancelado/Arquivado) e
   "Aguardando resposta" é preservado. */
function nextOnOpen(current) {
  const status = normalize(current);
  if (status === "Novo" || status === "Respondido") return "Atendimento iniciado";
  return status;
}

/* Atendente enviou mensagem: agora espera o retorno do cliente. */
function nextOnOutgoing() {
  return "Aguardando resposta";
}

module.exports = {
  STATUSES,
  DEFAULT_STATUS,
  isValid,
  normalize,
  nextOnIncoming,
  nextOnOpen,
  nextOnOutgoing,
};
