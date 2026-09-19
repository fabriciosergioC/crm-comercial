const crypto = require('node:crypto');
const { supabase, isConfigured } = require('../config/supabase');
const { ApiError } = require('../middleware/errorHandler');
const { mapDbError } = require('./modelHelpers');

const DEFAULT_PASSWORD = process.env.DEFAULT_USER_PASSWORD || 'Crm@2026!Inicial';
const HASH_LENGTH = 64;

function assertReady() {
  if (!isConfigured || !supabase) {
    throw new ApiError(503, 'Supabase não configurado — defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no .env do backend.');
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new ApiError(400, 'A senha deve ter entre 8 e 128 caracteres.');
  }
  if (typeof salt !== 'string' || !salt) {
    throw new ApiError(500, 'Sal de senha inválido.');
  }
  return {
    salt,
    hash: crypto.scryptSync(password, salt, HASH_LENGTH).toString('hex'),
  };
}

function passwordsMatch(password, salt, expectedHash) {
  try {
    const candidate = Buffer.from(hashPassword(password, salt).hash, 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch (error) {
    return false;
  }
}

function passwordParts(stored) {
  if (typeof stored !== 'string') return null;
  const separator = stored.lastIndexOf(':');
  if (separator < 1 || separator === stored.length - 1) return null;
  return { salt: stored.slice(0, separator), hash: stored.slice(separator + 1) };
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name };
}

async function getUserAuth(userId) {
  assertReady();
  const { data, error } = await supabase
    .from('users')
    .select('id, name, active, password_hash, must_change_password')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw mapDbError(error, 'Falha ao consultar o usuário.');
  if (!data) throw new ApiError(404, 'Usuário não encontrado.');
  return data;
}

async function saveAuth(userId, password, mustChangePassword) {
  const credential = hashPassword(password);
  const { data, error } = await supabase
    .from('users')
    .update({
      password_hash: `${credential.salt}:${credential.hash}`,
      must_change_password: mustChangePassword,
      password_updated_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select('id, name, active, password_hash, must_change_password')
    .single();
  if (error) throw mapDbError(error, 'Falha ao salvar a senha.');
  return data;
}

async function getAuthStatus(userId) {
  const user = await getUserAuth(userId);
  return {
    hasPassword: Boolean(user.password_hash),
    mustChangePassword: user.must_change_password !== false,
    defaultPassword: user.password_hash ? null : DEFAULT_PASSWORD,
  };
}

async function authenticate(userId, password) {
  const user = await getUserAuth(userId);
  if (user.active === false) throw new ApiError(403, 'Usuário desativado.');

  if (!user.password_hash) {
    const initial = hashPassword(DEFAULT_PASSWORD);
    if (!passwordsMatch(password, initial.salt, initial.hash)) {
      throw new ApiError(401, 'Usuário ou senha incorretos.');
    }
    const saved = await saveAuth(userId, DEFAULT_PASSWORD, true);
    return {
      user: publicUser(saved),
      mustChangePassword: true,
    };
  }

  const parts = passwordParts(user.password_hash);
  if (!parts || !passwordsMatch(password, parts.salt, parts.hash)) {
    throw new ApiError(401, 'Usuário ou senha incorretos.');
  }

  return {
    user: publicUser(user),
    mustChangePassword: user.must_change_password !== false,
  };
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = await getUserAuth(userId);
  if (user.active === false) throw new ApiError(403, 'Usuário desativado.');
  const parts = passwordParts(user.password_hash);
  if (!parts || !passwordsMatch(currentPassword, parts.salt, parts.hash)) {
    throw new ApiError(401, 'Senha atual incorreta.');
  }
  const saved = await saveAuth(userId, newPassword, false);
  return { user: publicUser(saved), mustChangePassword: false };
}

async function createUser(payload) {
  assertReady();
  const credential = hashPassword(DEFAULT_PASSWORD);
  const row = {
    id: payload.id,
    name: payload.name,
    active: payload.active !== false,
    password_hash: `${credential.salt}:${credential.hash}`,
    must_change_password: true,
    password_updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('users').insert(row).select('id, name, active').single();
  if (error) throw mapDbError(error, 'Falha ao criar o usuário.');
  return publicUser(data);
}

module.exports = {
  DEFAULT_PASSWORD,
  hashPassword,
  passwordsMatch,
  authenticate,
  changePassword,
  createUser,
  getUserAuth,
  getAuthStatus,
};
