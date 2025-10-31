import React, { useState } from 'react';
import './LoginPage.css';
import bg from './image/bg.webp';

export default function LoginPage({ onSubmit }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  function validate(u = username, p = password) {
    if (!u) return 'Username wajib diisi';
    if (!p) return 'Password wajib diisi';
    return '';
  }

  function handleSubmit(e) {
    e.preventDefault();
    // trim inputs to avoid accidental whitespace causing auth failure
    const trimmedUsername = username ? username.trim() : '';
    const trimmedPassword = password ? password.trim() : '';
    const v = validate(trimmedUsername, trimmedPassword);
    if (v) {
      // show validation message and DO NOT submit to server
      setError(v);
      return;
    }

    setError('');
    // submit trimmed credentials
    if (onSubmit) onSubmit({ username: trimmedUsername, password: trimmedPassword });
    else console.log('login', { username: trimmedUsername, password: trimmedPassword });
  }

  return (
    <div className="login-page" style={{ backgroundImage: `url(${bg})` }}>
      <div className="login-card">
        <h2>Masuk</h2>
        {error && <div className="error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <label>
            Username
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="username"
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="******"
            />
          </label>
          <button type="submit" className="btn">Masuk</button>
        </form>
      </div>
    </div>
  );
}
