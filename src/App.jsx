import React, { useState } from 'react';
import LoginPage from './views/LoginPage';
import ChatPage from './views/ChatPage';

export default function App() {
  const [user, setUser] = useState(null);

  async function handleLogin(credentials) {
    // kirim ke backend API (pastikan backend berjalan di http://localhost:4000)
    try {
      // normalize and trim incoming credentials
      const username = credentials.username ? String(credentials.username).trim() : '';
      const password = credentials.password ? String(credentials.password).trim() : '';
      console.log('Login submitted', { username, password: password ? '***' : '' });

      // basic client-side guard
      if (!username || !password) {
        alert('Gagal: Username/email dan password wajib diisi');
        return;
      }

      // if the user typed an email into the username field, send it as `email`
      const payload = {};
      if (username.includes('@')) {
        payload.email = username;
      } else {
        payload.username = username;
      }
      payload.password = password;

      const apiBase = import.meta.env.VITE_API_URL || '';
      const res = await fetch(`${apiBase}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { console.error('Invalid JSON from login:', text); }
      if (!res.ok) {
        const msg = data && data.error ? data.error : 'Login gagal';
        alert('Gagal: ' + msg);
        return;
      }

      // sukses — set user and navigate to chat
      console.log('Login response', data);
      setUser(data);
    } catch (err) {
      console.error(err);
      alert('Terjadi error saat menghubungi server');
    }
  }

  if (user) return <ChatPage user={user} onLogout={() => setUser(null)} />;

  return <LoginPage onSubmit={handleLogin} />;
}
