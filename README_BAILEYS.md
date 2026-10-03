# CRM + WhatsApp via Baileys

Esta versão do CRM usa Baileys em vez da WhatsApp Cloud API.

- Interface de atendimento dentro do CRM
- Conexão por QR Code ou Pairing Code
- Sessão persistente em `data/whatsapp-auth`
- Recebimento de mensagens em tempo real
- Envio de mensagens pelo CRM
- Histórico salvo no Supabase
- Sem Cloud API da Meta
- Sem webhook da Meta

## Instalação rápida no Windows

1. Tenha Node.js 20+ instalado.
2. Execute `INSTALAR_BAILEYS.bat`.
3. Configure `backend/.env` com as credenciais do Supabase.
4. Execute `run-crm.bat`.
5. Abra a seção WhatsApp.
6. Para autenticar pelo celular, informe o número com DDI no campo antes de
   clicar em **Conectar WhatsApp**; use o código em WhatsApp → Configurações →
   Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone.
7. Sem número, escaneie o QR Code exibido na tela do CRM usando
   WhatsApp → Dispositivos conectados → Conectar dispositivo. Se a conexão não
   responder em até 30 segundos, o CRM informa a falha e permite tentar novamente.

## Atenção

Baileys é uma biblioteca não oficial para interação com o WhatsApp Web. Ela não é afiliada ao WhatsApp. O próprio projeto recomenda não usar a biblioteca para spam, disparos em massa ou automação abusiva.
