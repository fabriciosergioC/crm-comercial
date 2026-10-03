# WhatsApp do CRM usando Baileys

O CRM foi adaptado para usar `@whiskeysockets/baileys` como camada de conexão com o WhatsApp Web, em vez da WhatsApp Cloud API.

## 1. Instalar dependências

Na pasta `backend`:

```bash
npm install
```

A dependência `@whiskeysockets/baileys` está declarada no `package.json`.

## 2. Configurar `.env`

Copie `.env.example` para `.env` e preencha:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WHATSAPP_PROVIDER=baileys`

Opcionalmente, defina `WHATSAPP_PAIRING_PHONE` com DDI + número, somente dígitos. Exemplo: `5531999999999`.

## 3. Banco

Aplique a migration existente `backend/database/migrations/004_whatsapp_cloud.sql`. O nome da migration é histórico; as tabelas são genéricas e também funcionam com Baileys.

## 4. Conectar

Abra a página WhatsApp no CRM e clique em **Conectar WhatsApp**.

- Sem `WHATSAPP_PAIRING_PHONE`: o backend gera um QR Code.
- Com `WHATSAPP_PAIRING_PHONE`: o backend solicita um Pairing Code.

Depois da autenticação, a sessão fica salva em `WHATSAPP_AUTH_DIR`.

## 5. Importante

Baileys é uma biblioteca não oficial e não é afiliada ao WhatsApp. O projeto oficial do Baileys alerta contra spam, mensagens em massa automatizadas e uso abusivo. Use a integração para atendimento e gestão legítima das conversas.
