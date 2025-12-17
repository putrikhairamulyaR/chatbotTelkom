import React, { useState } from 'react';
import LoginPage from './views/LoginPage.jsx';
import ChatPage from './views/ChatPage';
import StatisticsPage from './views/StatisticsPage.jsx';
import LandingPage from './views/LandingPage.jsx';
import AdminPage from './views/AdminPage.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [showLanding, setShowLanding] = useState(true); // <-- Control halaman Landing
  const [currentPage, setCurrentPage] = useState('chat'); // 'chat' or 'statistics'

  async function handleLogin(credentials) {
    try {
      const username = credentials.username
        ? String(credentials.username).trim()
        : '';
      const password = credentials.password
        ? String(credentials.password).trim()
        : '';

      if (!username || !password) {
        return { ok: false, error: 'Username/email dan password wajib diisi' };
      }

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

      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        console.error('Invalid JSON:', text);
      }

      if (!res.ok) {
        if (res.status === 401) {
          return { ok: false, error: 'Username atau password salah' };
        } else if (res.status === 400) {
          return { ok: false, error: data?.error || 'Form login tidak valid' };
        } else {
          return { ok: false, error: 'Terjadi kesalahan saat login' };
        }
      }

      // Ensure id_user exists
      if (!data?.id_user) {
        console.error('Login response missing id_user:', data);
        return { ok: false, error: 'Server tidak mengembalikan ID user. Silakan coba lagi.' };
      }

      console.log('[App] Login successful:', { id_user: data.id_user, username: data.username, role: data.role });
      // Persist token for session use (optional)
      try { if (data?.token) localStorage.setItem('auth_token', data.token); } catch {}
      setUser(data); // <-- Login sukses (includes token)
      
      // Jika admin, langsung redirect ke admin page
      if (data?.role === 'admin') {
        setCurrentPage('admin');
      }
      return { ok: true };
    } catch (err) {
      console.error(err);
      return { ok: false, error: 'Terjadi error saat menghubungi server' };
    }
  }

  // ==============================
  //       HALAMAN YANG MUNCUL
  // ==============================

  // 1. Landing Page pertama kali
  if (showLanding) {
    return <LandingPage onEnter={() => setShowLanding(false)} />;
  }

  // 2. Belum login → tampilkan LoginPage
  if (!user) {
    return <LoginPage onSubmit={handleLogin} />;
  }

  // 3. Sudah login → tampilkan halaman sesuai role
  if (user?.role === 'admin' || currentPage === 'admin') {
    return (
      <AdminPage
        user={user}
        onLogout={() => {
          try { localStorage.removeItem('auth_token'); } catch {}
          setUser(null);
          setCurrentPage('chat');
        }}
      />
    );
  }

  if (currentPage === 'statistics') {
    return (
      <StatisticsPage
        user={user}
        onBack={() => setCurrentPage('chat')}
        onLogout={() => {
          try { localStorage.removeItem('auth_token'); } catch {}
          setUser(null);
          setCurrentPage('chat');
        }}
      />
    );
  }

  return (
    <ChatPage
      user={user}
      onLogout={() => {
        try { localStorage.removeItem('auth_token'); } catch {}
        setUser(null);
      }}
    />
  );
}