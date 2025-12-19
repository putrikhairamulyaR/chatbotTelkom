// server/services/authService.js
import bcrypt from 'bcryptjs';
import { getUserByField, updateUserByUsername } from '../models/userModel.js';
import { pool } from '../db.js';
// Email notifications and reset tokens are disabled per requirements
import { signToken } from '../utils/jwt.js';

export async function login(payload, meta = {}) {
  const ip = meta.ip || null;
  const ua = meta.ua || null;
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

  // Throttle/lock check: >=3 gagal -> 10 menit, >5 gagal -> 1 jam
  const key = String(idValue || '').toLowerCase();
  const now = new Date();
  try {
    // read or create row
    const [rows] = await pool.query('SELECT * FROM login_throttle WHERE `key_id` = ? LIMIT 1', [key]);
    let row = rows && rows[0];
    if (!row) {
      await pool.query('INSERT INTO login_throttle (`key_id`, fail_count, last_fail, locked_until, user_id, email) VALUES (?,?,?,?,?,?)', [
        key,
        0,
        null,
        null,
        user ? user.id_user : null,
        user ? (user.email || null) : null,
      ]);
      row = { fail_count: 0, locked_until: null };
    }
    if (row.locked_until && new Date(row.locked_until) > now) {
      const ms = new Date(row.locked_until).getTime() - now.getTime();
      const minutes = Math.ceil(ms / 60000);
      const err = new Error(`Terlalu banyak percobaan login. Coba lagi dalam ${minutes} menit.`);
      err.code = 429;
      throw err;
    }
  } catch (e) {
    if (e && e.code === 429) throw e; // propagate lock
    // continue even if throttle query fails
  }
  if (!user) {
     const err = new Error('Username atau password salah');
    err.code = 401;

    // increment throttle for unknown identifiers too
    try {
      const [row] = await pool.query('SELECT fail_count FROM login_throttle WHERE `key_id` = ? LIMIT 1', [key]);
      const fc = (row && row[0] && row[0].fail_count) || 0;
      const next = fc + 1;
      let lockedUntil = null;
      // Tiered lock: >=3 -> 10 menit, >5 -> 1 jam
      if (next > 5) {
        lockedUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 jam
      } else if (next >= 3) {
        lockedUntil = new Date(Date.now() + 10 * 60 * 1000); // 10 menit
      }
      await pool.query('UPDATE login_throttle SET fail_count = ?, last_fail = NOW(), locked_until = ? WHERE `key_id` = ?', [
        next,
        lockedUntil ? new Date(lockedUntil) : null,
        key,
      ]);
      // log failed attempt (unknown user)
      await pool.query('INSERT INTO login_fail_log (key_id, user_id, ip_address, user_agent) VALUES (?,?,?,?)', [
        key,
        null,
        ip,
        ua,
      ]);
    } catch {}

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

    // Update throttle counters and possibly lock + notify
    try {
      const [rows] = await pool.query('SELECT fail_count FROM login_throttle WHERE `key_id` = ? LIMIT 1', [key]);
      const fc = (rows && rows[0] && rows[0].fail_count) || 0;
      const next = fc + 1;
      let lockedUntil = null;
      // Tiered lock: >=3 -> 10 menit, >5 -> 1 jam
      if (next > 5) {
        lockedUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 jam
      } else if (next >= 3) {
        lockedUntil = new Date(Date.now() + 10 * 60 * 1000); // 10 menit
      }
      await pool.query('UPDATE login_throttle SET fail_count = ?, last_fail = NOW(), locked_until = ?, user_id = COALESCE(user_id, ?), email = COALESCE(email, ?) WHERE `key_id` = ?', [
        next,
        lockedUntil ? new Date(lockedUntil) : null,
        user.id_user,
        user.email || null,
        key,
      ]);
      // log failed attempt (known user)
      await pool.query('INSERT INTO login_fail_log (key_id, user_id, ip_address, user_agent) VALUES (?,?,?,?)', [
        key,
        user.id_user,
        ip,
        ua,
      ]);
    } catch {}
    throw err;
  }

  const { id_user, username: userName, email: userEmail, prodi, role } = user;
  const token = signToken({ id_user, role: role || 'user' });

  // Reset throttle counters on successful login
  try {
    await pool.query('UPDATE login_throttle SET fail_count = 0, locked_until = NULL WHERE `key_id` = ?', [key]);
  } catch {}

  return { id_user, username: userName, email: userEmail, prodi, role: role || 'user', token };
}
