(function () {
  localStorage.setItem('crm_auth_session', JSON.stringify({ userId: 'fabricio' }));
  const leads = [
    { id: 'l1', company: 'Barbearia do Zé', contactName: 'José Silva', whatsapp: '(31) 99999-1111', phone: '', city: 'Ipatinga', status: 'Novo', segment: 'Barbearia' },
    { id: 'l2', company: 'Studio Bella', contactName: 'Ana Souza', whatsapp: '(31) 98888-2222', phone: '', city: 'Ipatinga', status: 'Contatado', segment: 'Salão' }
  ];
  const mkMessages = n => Array.from({ length: n }, (_, i) => ({
    id: 'm' + i,
    direction: i % 3 === 0 ? 'outgoing' : 'incoming',
    content: 'Mensagem de teste número ' + i + ' da conversa.',
    timestamp: new Date(Date.now() - (n - i) * 60000).toISOString(),
    status: 'read'
  }));
  const conversations = [
    { id: 'c1', contact: { name: 'José Silva', company: 'Barbearia do Zé', phone: '55 31 99999-1111' }, lastMessage: { timestamp: new Date().toISOString(), content: 'Última mensagem da conversa 1' }, unreadCount: 2 },
    { id: 'c2', contact: { name: 'Ana Souza', company: 'Studio Bella', phone: '55 31 98888-2222' }, lastMessage: { timestamp: new Date(Date.now() - 3600000).toISOString(), content: 'Ok, fico no aguardo' }, unreadCount: 0 }
  ];
  const detail = id => ({
    id, contact: conversations.find(c => c.id === id).contact,
    status: 'aberta',
    messages: mkMessages(30)
  });
  const json = data => new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const origFetch = window.fetch.bind(window);
  window.fetch = (url, options) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    if (path === '/api/health') return Promise.resolve(new Response(JSON.stringify({ ok: true, database: 'configurado' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (path === '/api/whatsapp/status') return Promise.resolve(json({ status: 'CONNECTED', phoneNumber: '55 31 97777-0000', accountName: 'Teste Local' }));
    if (path === '/api/whatsapp/conversations') return Promise.resolve(json(conversations));
    if (/^\/api\/whatsapp\/conversations\/[^/]+\/messages$/.test(path)) return Promise.resolve(json({ id: 'm-new', status: 'sent' }));
    if (/^\/api\/whatsapp\/conversations\/lead\//.test(path)) return Promise.resolve(json(detail('c2')));
    if (/^\/api\/whatsapp\/conversations\//.test(path)) return Promise.resolve(json(detail(path.split('/').pop())));
    if (path === '/api/leads') return Promise.resolve(json(leads));
    if (['/api/status-history', '/api/interactions', '/api/followups', '/api/demos', '/api/proposals', '/api/clients', '/api/client-updates'].includes(path)) return Promise.resolve(json([]));
    return origFetch(url, options);
  };
})();
