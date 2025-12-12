import React from "react";
import "./LandingPage.css";

export default function LandingPage({ onEnter }) {
  return (
    <div className="lp-wrapper">

      {/* PANEL KIRI */}
      <div className="lp-left">
        <div className="lp-overlay"></div>

        <div className="lp-content">
          <h1 className="lp-title">Sistem Chatbot FIT</h1>

          <div className="lp-grid">

            {/* Bahasa */}
            <div className="lp-box">
              <h2 className="lp-subtitle">Bahasa</h2>
              <p>Akses hanya untuk Dosen dan Mahasiswa Telkom University.</p>
              <p>
                Login menggunakan Akun Microsoft Office 365 dengan mengikuti
                petunjuk berikut:
              </p>
              <ul>
                <li>
                  <b>Username (SSO / Akun iGracias)</b> + <br />
                  @telkomuniversity.ac.id untuk <b>Pegawai</b>
                </li>
                <li>
                  <b>@student.telkomuniversity.ac.id</b> untuk <b>Mahasiswa</b>
                </li>
                <li>
                  <b>Password</b> (SSO / Akun iGracias)
                </li>
              </ul>
              <p>
                Bila terjadi kegagalan autentikasi, password Anda mungkin belum
                memenuhi syarat. Silakan ubah di iGracias.
              </p>
            </div>

            {/* English */}
            <div className="lp-box">
              <h2 className="lp-subtitle">English</h2>
              <p>
                Access restricted only for Lecturer and Students of
                Telkom University.
              </p>
              <p>
                Login only using your Microsoft Office 365 Account by following
                this format:
              </p>
              <ul>
                <li>
                  <b>Username (SSO / iGracias Account)</b> + <br />
                  @telkomuniversity.ac.id for <b>Lecturer & Staff</b>
                </li>
                <li>
                  <b>@student.telkomuniversity.ac.id</b> for <b>Student</b>
                </li>
                <li>
                  <b>Password</b> (SSO / iGracias Account)
                </li>
              </ul>
              <p>
                If you are experiencing authentication failures, your password
                may not meet the requirement. Please update it in iGracias.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* PANEL KANAN */}
      <div className="lp-right">
        <div className="lp-login-card">
          <h2 className="lp-login-title">Masuk ke Akun</h2>
          <button className="lp-btn" onClick={onEnter}>
            Masuk / Login
          </button>
        </div>
      </div>

    </div>
  );
}
