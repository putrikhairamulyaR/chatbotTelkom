import React, { useState } from "react";
import "./LoginPage.css";
import bg from "./image/bg.webp";

export default function LoginPage({ onSubmit }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  // popup state
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  function validate() {
    if (!username) return "Username wajib diisi";
    if (!password) return "Password wajib diisi";
    return "";
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError("");
    if (onSubmit) {
      try {
        const res = await onSubmit({ username, password });
        if (!res || res.ok !== true) {
          setError((res && res.error) || 'Terjadi kesalahan saat login');
        }
      } catch (err) {
        setError('Terjadi kesalahan saat login');
      }
    }
  }

  return (
    <div className="layout">

      {/* ================= LEFT / HERO ================= */}
      <div
        className="left-section"
        style={{ backgroundImage: `url(${bg})` }}
      >
        <div className="overlay" />

        <div className="left-content">
          <h1 className="title-main">Selamat Datang di</h1>
          <h2 className="title-app">Sistem Chatbot</h2>
          <p className="subtitle">FIT Telkom University</p>

          <div className="divider" />

          <p className="desc">
            Sistem layanan informasi akademik berbasis chatbot
            untuk Dosen dan Mahasiswa Telkom University.
          </p>
        </div>
      </div>

      {/* ================= RIGHT / LOGIN ================= */}
      <div className="right-section">
        <div className="login-box">
          <h3 className="login-title">Login</h3>

          {/* Error pindah ke bawah tombol login */}

          <form onSubmit={handleSubmit}>
            <label>Username</label>
            <input
              type="text"
              placeholder="Masukkan username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />

            <label>Password</label>
            <input
              type="password"
              placeholder="Masukkan password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />

            <button type="submit" className="btn-login">
              Login
            </button>

            {error && (
              <div className="error-inline" role="alert" aria-live="polite">
                {error}
              </div>
            )}
          </form>

          <div className="login-info">
            <p>Kontak keluhan:</p>

            <button
              className="help-btn"
              onClick={() => setIsPopupOpen(true)}
            >
              <img
                src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg"
                alt="WhatsApp"
              />
              Helpdesk PuTI
            </button>
          </div>
        </div>
      </div>

      {/* ================= POPUP ================= */}
      {isPopupOpen && (
        <div className="popup-overlay">
          <div className="popup-box">
            <h3>Kontak Helpdesk PuTI</h3>
            <p>
              WhatsApp: <strong>0823-1994-9941</strong>
            </p>

            <button
              className="btn-copy"
              onClick={() => {
                navigator.clipboard.writeText("082319949941");
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              Copy Nomor
            </button>

            {copied && <p className="copy-text">Nomor berhasil disalin!</p>}

            <button
              className="btn-close"
              onClick={() => setIsPopupOpen(false)}
            >
              Tutup
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
