// server/controllers/authController.js
import { login } from '../services/authService.js';

export async function handleLogin(req, res) {
  try {
    const result = await login(req.body || {});
    return res.json(result);
  } catch (err) {
    if (err && err.code === 400) return res.status(400).json({ error: err.message });
    if (err && err.code === 401) return res.status(401).json({ error: err.message });
    console.error('[auth] login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
