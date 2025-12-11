import React, { useState } from "react";
import "./LoginPage.css";
import bg from "./image/bg.webp";

export default function LoginPage({ onSubmit }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  function validate() {
    if (!username) return "Username wajib diisi";
    if (!password) return "Password wajib diisi";
    return "";
  }

  function handleSubmit(e) {
    e.preventDefault();
    const v = validate();
    if (v) {
      setError(v);
      return;
    }
    setError("");
    if (onSubmit) onSubmit({ username, password });
  }

  return (
    <div className="layout">
      {/* Left Section */}
      <div className="left-section" style={{ backgroundImage: `url(${bg})` }}>
        <div className="overlay"></div>
        <div className="left-content">
          <h1 className="title-main">Selamat Datang di</h1>
          <h2 className="title-app">Chatbot</h2>
          <p className="subtitle">Sistem Chatbot FIT Telkom University</p>
        </div>
      </div>

      {/* Right Section */}
      <div className="right-section">
        <div className="login-box">
          <h3 className="login-title">Login</h3>

          {error && <div className="error">{error}</div>}

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
          </form>

          <div className="login-info">
            <p>Kontak keluhan:</p>

          <a href="#" className="help-btn">
            <img 
              src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg"
              alt="WhatsApp"
              style={{ width: "18px", height: "18px" }}
            />
            Helpdesk PuTI
          </a>
          </div>
        </div>
      </div>
    </div>
  );
}
