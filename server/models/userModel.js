// server/models/userModel.js
import { pool } from '../db.js';

export async function getUserByField(field, value) {
  if (!['username', 'email', 'id_user'].includes(field)) {
    throw new Error('Invalid user field');
  }
  const [rows] = await pool.query(
    `SELECT * FROM \`user\` WHERE ${field} = ? LIMIT 1`,
    [value]
  );
  return rows[0] || null;
}

export async function createUser({ username, email, password, prodi, role = 'user' }) {
  const [res] = await pool.query(
    'INSERT INTO `user` (username, email, password, prodi, role) VALUES (?,?,?,?,?)',
    [username, email, password, prodi, role]
  );
  return res.insertId;
}

export async function updateUserByUsername(username, fields) {
  const allowed = ['password', 'role', 'prodi'];
  const keys = Object.keys(fields).filter(k => allowed.includes(k));
  if (!keys.length) return 0;
  const setSql = keys.map(k => `${k} = ?`).join(', ');
  const params = keys.map(k => fields[k]);
  params.push(username);
  const [res] = await pool.query(`UPDATE \`user\` SET ${setSql} WHERE username = ?`, params);
  return res.affectedRows || 0;
}
