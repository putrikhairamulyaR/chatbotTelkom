// server/services/authService.js
import bcrypt from 'bcryptjs';
import { getUserByField } from '../models/userModel.js';

export async function login(payload) {
  const { username, email, password } = payload || {};
  const usernameTrim = username ? String(username).trim() : '';
  const emailTrim = email ? String(email).trim() : '';
  const passwordRaw = password ? String(password).trim() : '';

  const idValue = usernameTrim || emailTrim;
  if (!idValue || !passwordRaw) {
    const err = new Error('Username/email and password required');
    err.code = 400;
    throw err;
  }

  const field = usernameTrim ? 'username' : 'email';
  const user = await getUserByField(field, idValue);
  if (!user) {
    const err = new Error('Invalid credentials');
    err.code = 401;
    throw err;
  }

  let match = false;
  try {
    match = await bcrypt.compare(passwordRaw, user.password || '');
  } catch {
    match = false;
  }

  // plaintext fallback
  if (!match && user.password && passwordRaw === user.password) {
    console.warn(`Warning: authenticating user ${user.email || user.username} using plain-text password fallback.`);
    match = true;
  }

  if (!match) {
    const err = new Error('Invalid credentials');
    err.code = 401;
    throw err;
  }

  const { id_user, username: userName, email: userEmail, prodi, role } = user;
  return { id_user, username: userName, email: userEmail, prodi, role: role || 'user' };
}
