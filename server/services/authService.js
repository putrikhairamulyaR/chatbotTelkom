// server/services/authService.js
import bcrypt from 'bcryptjs';
import { getUserByField, updateUserByUsername } from '../models/userModel.js';
import { signToken } from '../utils/jwt.js';

export async function login(payload) {
  const { username, email, password } = payload || {};
  const usernameTrim = username ? String(username).trim() : '';
  const emailTrim = email ? String(email).trim() : '';
  const passwordRaw = password ? String(password).trim() : '';

  const idValue = usernameTrim || emailTrim;
    if (!idValue || !passwordRaw) {
      const err = new Error('Username/email dan password wajib diisi');
    err.code = 400;
    throw err;
  }

  // Basic input hardening to reduce injection attempts and malformed input
  const SAFE_ID = /^[A-Za-z0-9._@+-]{1,150}$/; // allow typical username/email chars
  const SAFE_PW_MAX = 256;
  if (usernameTrim && !SAFE_ID.test(usernameTrim)) {
     const err = new Error('Format username tidak valid');
    err.code = 400;
    throw err;
  }
  if (emailTrim) {
    // very light email sanity; still allow most valid addresses
      const EMAIL_OK = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!SAFE_ID.test(emailTrim) || !EMAIL_OK.test(emailTrim) || emailTrim.length > 150) {
        const err = new Error('Format email tidak valid');
      err.code = 400;
      throw err;
    }
  }
  if (passwordRaw.length === 0 || passwordRaw.length > SAFE_PW_MAX) {
     const err = new Error('Password tidak valid');
    err.code = 400;
    throw err;
  }

  const field = usernameTrim ? 'username' : 'email';
  const user = await getUserByField(field, idValue);
  if (!user) {
     const err = new Error('Username atau password salah');
    err.code = 401;
    throw err;
  }

  let match = false;
  try {
    match = await bcrypt.compare(passwordRaw, user.password || '');
  } catch {
    match = false;
  }

  if (!match) {
    // If DB stored plaintext (legacy), migrate it to bcrypt when matched
    if (user.password && user.password === passwordRaw) {
      try {
        const hashed = await bcrypt.hash(passwordRaw, 10);
        await updateUserByUsername(user.username, { password: hashed });
        match = true;
      } catch {
        // ignore migration failure and continue to invalid creds
      }
    }
  }

  if (!match) {
     const err = new Error('Username atau password salah');
    err.code = 401;
    throw err;
  }

  const { id_user, username: userName, email: userEmail, prodi, role } = user;
  const token = signToken({ id_user, role: role || 'user' });
  return { id_user, username: userName, email: userEmail, prodi, role: role || 'user', token };
}
