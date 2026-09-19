const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const usersService = require('../services/usersService');
const { ApiError } = require('../middleware/errorHandler');
const V = require('../middleware/validate');

const router = express.Router();

router.post('/login', asyncHandler(async (req, res) => {
  const body = req.body || {};
  V.ensureObject(body);
  V.rejectUnknown(body, ['userId', 'password']);
  const payload = {
    userId: V.str(body, 'userId', { required: true, max: 100 }),
    password: V.str(body, 'password', { required: true, max: 128 }),
  };
  const data = await usersService.authenticate(payload.userId, payload.password);
  res.json({ success: true, data });
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
  res.json({ success: true, data });
}));

router.get('/status/:userId', asyncHandler(async (req, res) => {
  const userId = V.str({ value: req.params.userId }, 'value', { required: true, max: 100 });
  const data = await usersService.getAuthStatus(userId);
  res.json({ success: true, data });
}));

module.exports = router;
