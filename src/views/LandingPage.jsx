import React, { useEffect } from "react";
import "./LandingPage.css";

export default function LandingPage({ onEnter }) {

  useEffect(() => {
    const timer = setTimeout(() => {
      onEnter();
    }, 3000);

    return () => clearTimeout(timer);
  }, [onEnter]);

  return (
    <div className="lp-wrapper">
      <div className="lp-overlay"></div>

      <div className="lp-content">

        <h1 className="lp-title">Sistem Chatbot FIT</h1>

        <p className="lp-subtitle">
          Fakultas Ilmu Terapan – Telkom University
        </p>

        <div className="lp-divider"></div>

        <p className="lp-text">
          Akses hanya untuk Mahasiswa Telkom University
        </p>

        <p className="lp-redirect">Redirecting to login...</p>

      </div>
    </div>
  );
}
