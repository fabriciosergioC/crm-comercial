"""
Agente de IA do CRM para ligações pelo navegador (LiveKit Cloud).

O CRM cria a sala e aciona este agente pelo nome. O contexto do lead (empresa,
etapa do funil, últimas interações) chega no metadata do job, montado pelo
backend em `backend/routes/aiRoutes.js`.

Voz na nuvem: STT, LLM e TTS usam o LiveKit Inference — não precisa de chave da
OpenAI/Deepgram/Cartesia, só das credenciais do próprio projeto LiveKit.

Rodar local:      python agent.py dev
Publicar na nuvem: lk agent create   (LiveKit CLI)
"""

import json
import os

from livekit import agents
from livekit.agents import Agent, AgentSession, RoomInputOptions, WorkerOptions, cli, inference
from livekit.plugins import silero

# Modelos do LiveKit Inference (podem ser trocados por variável de ambiente).
STT_MODEL = os.getenv("LK_STT_MODEL", "deepgram/nova-3")
LLM_MODEL = os.getenv("LK_LLM_MODEL", "google/gemma-4-31b-it")
TTS_MODEL = os.getenv("LK_TTS_MODEL", "gradium/default")
TTS_VOICE = os.getenv("LK_TTS_VOICE", "Bianca")
LANGUAGE = os.getenv("LK_LANGUAGE", "pt-BR")
AGENT_NAME = os.getenv("LIVEKIT_AGENT_NAME", "sofia-crm")


def instrucoes(meta: dict) -> str:
    nome = meta.get("assistantName") or "Sofia"
    empresa = meta.get("companyName") or "nossa equipe"
    lead = meta.get("leadName") or "o cliente"
    empresa_lead = meta.get("company") or ""
    contexto = meta.get("context") or ""

    linhas = [
        f"Você é {nome}, atendente comercial de {empresa}.",
        "Você está em uma LIGAÇÃO DE VOZ por telefone/navegador com um lead. Fale de forma",
        "natural, curta e educada, em português do Brasil. Uma ideia por vez, frases curtas.",
        "Nunca invente preço, prazo, condição comercial ou informação que não esteja no contexto;",
        "se faltar algo, diga que vai confirmar com a equipe. Não peça dados sensíveis.",
        "Deixe o cliente falar e não interrompa. Se ele pedir para encerrar, agradeça e se despeça.",
        "",
        f"Lead: {lead}" + (f" — empresa {empresa_lead}" if empresa_lead else ""),
    ]
    if meta.get("phone"):
        linhas.append(f"Telefone cadastrado: {meta['phone']}")
    if contexto:
        linhas.extend(["", "Contexto do CRM (use apenas o que fizer sentido):", contexto[:6000]])
    linhas.extend([
        "",
        "Comece cumprimentando pelo nome, diga quem você é e pergunte se é um bom momento",
        "para falar rapidamente. Se a pessoa já estiver falando, espere ela terminar.",
    ])
    return "\n".join(linhas)


class Atendente(Agent):
    def __init__(self, instructions: str) -> None:
        super().__init__(instructions=instructions)


async def entrypoint(ctx: agents.JobContext) -> None:
    meta: dict = {}
    try:
        meta = json.loads(ctx.job.metadata or "{}")
    except Exception:
        meta = {}

    await ctx.connect()

    session = AgentSession(
        stt=inference.STT(model=STT_MODEL, language=LANGUAGE),
        llm=inference.LLM(model=LLM_MODEL),
        tts=inference.TTS(model=TTS_MODEL, voice=TTS_VOICE, language=LANGUAGE),
        vad=silero.VAD.load(),
    )

    await session.start(
        room=ctx.room,
        agent=Atendente(instrucoes(meta)),
        room_input_options=RoomInputOptions(),
    )

    # Só abre a conversa quando o lead (ou o atendente) já está na sala.
    await session.generate_reply(
        instructions="Cumprimente a pessoa pelo nome, apresente-se e pergunte se pode falar agora."
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))
