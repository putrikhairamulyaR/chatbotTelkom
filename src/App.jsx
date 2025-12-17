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
        alert('Gagal: Username/email dan password wajib diisi');
        return;
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
        alert('Gagal: ' + (data?.error || 'Login gagal'));
        return;
      }

      // Ensure id_user exists
      if (!data?.id_user) {
        console.error('Login response missing id_user:', data);
        alert('Error: Server tidak mengembalikan ID user. Silakan coba lagi.');
        return;
      }

      console.log('[App] Login successful:', { id_user: data.id_user, username: data.username, role: data.role });
      setUser(data); // <-- Login sukses
      
      // Jika admin, langsung redirect ke admin page
      if (data?.role === 'admin') {
        setCurrentPage('admin');
      }
    } catch (err) {
      console.error(err);
      alert('Terjadi error saat menghubungi server');
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
          setUser(null);
          setCurrentPage('chat');
        }}
      />
    );
  }

  return (
    <ChatPage
      user={user}
      onLogout={() => setUser(null)}
    />
  );
}