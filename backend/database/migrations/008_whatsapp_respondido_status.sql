-- Renomeia o status após o envio de uma mensagem: Aguardando resposta -> Respondido.
-- A normalização do backend já reconhece o rótulo antigo, então esta atualização
-- é segura para executar sem interromper o atendimento e pode ser reexecutada.
update public.whatsapp_conversations
   set status = 'Respondido'
 where status = 'Aguardando resposta';
