# Banco de dados — Supabase (`backend/database`)

Estrutura do banco do CRM. **Nada aqui apaga dados**: só existem
`create table if not exists`, `create index if not exists`,
`create or replace function`, `alter table ... enable row level security`,
`revoke`/`grant` e `create trigger`.

## Ordem de execução (exatamente assim)

| # | Arquivo | O que faz |
|---|---|---|
| 1 | `schema.sql` | 9 tabelas, constraints, índices e trigger de `updated_at` |
| 2 | `functions.sql` | 2 funções RPC: `change_lead_status`, `add_lead_interaction` |
| 3 | `rls.sql` | Habilita RLS, tira acesso de `anon`/`authenticated`, libera `service_role` |
| 4 | `migrations/002_auth.sql` | adiciona hash, indicador de troca obrigatória e data da senha em `users` |

**Como aplicar:** cole o conteúdo de cada arquivo, na ordem acima, no **SQL
Editor** do painel do Supabase.

**Atalho (recomendado):** `apply_all.sql` é **gerado automaticamente** a partir
dos 3 arquivos (schema + functions + rls, nessa ordem) — cole esse arquivo
**uma única vez** no SQL Editor e rode. A fonte continua sendo os 3 arquivos;
não edite o bundle à mão (se precisar regerar, peça que eu recrio).

> ⚠️ Cuidado com o arquivo errado — o SQL Editor só aceita SQL:
> - ✅ `apply_all.sql` (ou `schema.sql` → `functions.sql` → `rls.sql`)
> - ❌ `scripts/test-supabase.js` (script Node: começa com `#!/usr/bin/env node`
>   e o SQL Editor responde `syntax error at or near "#!/"`)
> - ❌ `migrations/001_initial.sql` / `README.md` (não contêm SQL executável)
> - ❌ `functions.sql` **antes** de `schema.sql` (as tabelas ainda não existem)

Se você preferir aplicar de forma automatizada (script Node com o pacote `pg` +
`DATABASE_URL`), é preciso autorizar essa dependência extra antes.

> Status: os arquivos estão **prontos, mas ainda NÃO aplicados** no Supabase —
> não existem credenciais no projeto (`backend/.env` não existe).

## Tabelas

| Tabela | Papel | Relações |
|---|---|---|
| `users` | Vendedores/donos (espelha a constante `USERS`) e credenciais de acesso | pai de `leads.owner`, `lead_interactions."user"`, `lead_followups.created_by`, `lead_demos.owner`, `clients.owner` |
| `leads` | Oportunidade comercial (entidade central) | `owner → users` |
| `lead_status_history` | Auditoria de mudança de status | `lead_id → leads` (cascade) |
| `lead_interactions` | Contatos realizados | `lead_id → leads` (cascade) |
| `lead_followups` | Tarefas de retorno | `lead_id → leads` (cascade) |
| `lead_demos` | Prévias com validade (padrão 24h) | `lead_id → leads` (cascade) |
| `lead_proposals` | Propostas comerciais | `lead_id → leads` (cascade) |
| `clients` | Cliente convertido | `lead_id → leads` (**1:1**, `unique`) |
| `client_updates` | Histórico de alterações do cliente | `client_id → clients` (cascade) |

## Decisões de modelagem (e o porquê)

1. **`id` é `text`** — o front-end e os services já geram/transportam ids de
   texto (`l1`, `i_...`, `sh_...`) e `leadsService` repassa o id sem tocar.
   Usar `uuid` exigiria mudar o front-end (proibido nesta etapa).
2. **`next_action` e `score` são `jsonb`** — é o que `leadsService.js` já
   declara em `JSONB_FIELDS`; o `score` valida 0–5 apenas quando a chave existe,
   para não bloquear payloads parciais.
3. **`loss_reason` é nullable** — o front muda o status para "Perdido" e grava
   o motivo em uma **segunda** chamada; exigir `not null` quebraria a primeira.
   Por isso a RPC `change_lead_status` aceita `p_loss_reason` opcional.
4. **`lead_followups.status` aceita `cancelado`** (usado em 2 pontos do front),
   valor que **ainda não existe** em `backend/models/enums.js`
   (`FOLLOWUP_STATUSES`). Divergência conhecida: corrigir com 1 linha lá,
   com sua autorização.
5. **RLS deny-by-default** — o navegador nunca fala com o Supabase; só o
   backend, com `service_role`. Não existe policy para `anon`/`authenticated`
   e nenhum `using (true)` foi criado.
6. **`client_updates`** existe no modelo do front (`initialDb.clientUpdates`)
   mas a UI ainda não lê — mantida por paridade, sem uso hoje.
7. **`users`** espelha `USERS` (`erick`, `fabricio`) e armazena apenas o hash da
   senha. Usuários sem hash recebem a senha padrão configurada no backend e
   precisam trocá-la no primeiro acesso.
8. **Sem `DELETE`** — a aplicação não exclui nada: follow-up vira `cancelado`,
   demo vira `deactivated`, proposta vira `Recusada`. Os `on delete cascade`
   existem só para integridade referencial.

## Convenção de migrações

`schema.sql`, `functions.sql` e `rls.sql` são o **estado atual** (o SQL canônico,
um arquivo por responsabilidade — sem DDL duplicada). O histórico fica em
`migrations/`: `001_initial.sql` descreve a versão inicial e as mudanças
futuras entram como arquivos SQL reais de delta (`002_*.sql`, `003_*.sql`),
nunca com `DROP TABLE`/`TRUNCATE`.

## O que este diretório NÃO faz

- não cria dados de teste (passo separado e controlado);
- não altera tabelas existentes de forma destrutiva;
- não toca no front-end nem em `frontend/`.