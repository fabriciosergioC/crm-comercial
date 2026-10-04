-- Lembrete de follow-up no WhatsApp.
--   notified_at marca quando o aviso de um follow-up já foi enviado ao celular,
--   para o agendador (backend/services/followupNotifier.js) não reenviar o mesmo
--   lembrete a cada tick. Reagendar o follow-up (nova due_date) zera a coluna.
--   Não apaga nada; pode ser reexecutado.
alter table public.lead_followups
  add column if not exists notified_at timestamptz;

-- Acelera a varredura do agendador: só follow-ups pendentes, vencidos e ainda
-- não notificados.
create index if not exists lf_pending_notify_idx
  on public.lead_followups (due_date)
  where status = 'pendente' and notified_at is null;
