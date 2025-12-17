// server/middleware/auth.js
import { pool } from '../db.js';
import { verifyToken } from '../utils/jwt.js';

function extractBearer(req) {
  const h = req.headers?.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

export async function requireAuth(req, res, next) {
  const token = extractBearer(req);
  if (!token) return res.status(401).json({ error: 'Missing token' });
  const payload = verifyToken(token);
  if (!payload || !payload.id_user) return res.status(401).json({ error: 'Invalid token' });

  // ensure user still exists
  try {
    const [rows] = await pool.query('SELECT id_user, username, email, prodi, role FROM `user` WHERE id_user = ? LIMIT 1', [payload.id_user]);
    if (!rows || rows.length === 0) return res.status(401).json({ error: 'User not found' });
    req.user = rows[0];
    return next();
  } catch (e) {
    return res.status(500).json({ error: 'Auth lookup failed' });
  }
}

export function requireAdmin(req, res, next) {
  const role = (req.user && req.user.role) || '';
  if (String(role).toLowerCase() !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  return next();
}

export function getOptionalUser(req) {
  const token = extractBearer(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || !payload.id_user) return null;
  return payload;
}
