const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const usersService = require('../services/usersService');
const { ApiError } = require('../middleware/errorHandler');
const { isLocalAccess } = require('../middleware/sessionGate');
const sessions = require('../services/sessionTokens');
const V = require('../middleware/validate');

const router = express.Router();

/* Toda resposta de login / troca de senha carrega a sessão assinada de dois
   jeitos, para o frontend não precisar de nada além de abrir o link:
     - cookie httpOnly  -> o navegador envia sozinho em toda chamada (mesma origem,
                           é o caminho do túnel ngrok e do seu notebook);
     - sessionToken     -> guardado no sessionStorage e enviado no cabeçalho
                           x-crm-session, para quando o site é aberto fora do
                           backend (file:// ou porta diferente).
   A senha nunca aparece na resposta, e o cookie httpOnly não é legível por
   JavaScript, então um script malicioso na página não consegue roubá-lo. */
function issueSession(req, res, user) {
  const token = sessions.signSession(user && user.id);
  sessions.applySessionCookie(req, res, token);
  return {
    sessionToken: token,
    sessionExpiresAt: token ? new Date(sessions.verifySession(token).expiresAt).toISOString() : null,
  };
}

router.post('/login', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['userId', 'password']);
  const payload = {
    userId: V.str(body, 'userId', { required: true, max: 100 }),
    password: V.str(body, 'password', { required: true, max: 128 }),
  };
  const data = await usersService.authenticate(payload.userId, payload.password);
  res.json({ success: true, data: { ...data, ...issueSession(req, res, data.user) } });
}));

router.post('/logout', (req, res) => {
  sessions.applySessionCookie(req, res, null);
  res.json({ success: true, data: { loggedOut: true } });
});

/* Cadastro protegido: somente Fabricio ou Erick podem criar novos acessos. */
router.post('/users', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['id', 'name', 'adminUserId', 'adminPassword']);
  const payload = {
    id: V.str(body, 'id', { required: true, min: 3, max: 100 }),
    name: V.str(body, 'name', { required: true, min: 2, max: 120 }),
    adminUserId: V.str(body, 'adminUserId', { required: true, max: 100 }),
    adminPassword: V.str(body, 'adminPassword', { required: true, max: 128 }),
  };
  if (!['fabricio', 'erick'].includes(payload.adminUserId.toLowerCase())) {
    throw new ApiError(403, 'Somente Fabricio ou Erick podem cadastrar usuários.');
  }
  await usersService.authenticate(payload.adminUserId.toLowerCase(), payload.adminPassword);
  const data = await usersService.createUser({ id: payload.id, name: payload.name });
  res.status(201).json({ success: true, data });
}));

router.post('/change-password', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['userId', 'currentPassword', 'newPassword']);
  const payload = {
    userId: V.str(body, 'userId', { required: true, max: 100 }),
    currentPassword: V.str(body, 'currentPassword', { required: true, max: 128 }),
    newPassword: V.str(body, 'newPassword', { required: true, min: 8, max: 128 }),
  };
  if (payload.newPassword.length < 8) {
    throw new ApiError(400, 'A nova senha deve ter pelo menos 8 caracteres.');
  }
  const data = await usersService.changePassword(payload.userId, payload.currentPassword, payload.newPassword);
  res.json({ success: true, data: { ...data, ...issueSession(req, res, data.user) } });
}));

/* GET /api/auth/users — só id e nome de quem pode entrar.
   Fica fora do portão de sessão porque a tela de entrada precisa mostrar a lista
   ANTES de qualquer login. Nenhum dado de cliente aparece aqui, e a senha jamais:
   é a mesma lista que já está escrita no arquivo do frontend. */
router.get('/users', asyncHandler(async (req, res) => {
  res.json({ success: true, data: await usersService.listUsers() });
}));

router.get('/status/:userId', asyncHandler(async (req, res) => {
  const userId = V.str({ value: req.params.userId }, 'value', { required: true, max: 100 });
  const data = await usersService.getAuthStatus(userId);
  /* A senha padrão só pode aparecer no seu notebook. Pela internet ela seria
     entregue para qualquer pessoa que chamasse /api/auth/status/fabricio — e como
     o mesmo valor está escrito no frontend, ela não é segredo por muito tempo.
     O frontend nunca usou este campo (a tela de entrada ignora defaultPassword),
     então escondê-lo não muda nada no fluxo de quem digita a senha. */
  if (!isLocalAccess(req) && data && 'defaultPassword' in data) {
    delete data.defaultPassword;
  }
  res.json({ success: true, data });
}));

module.exports = router;
