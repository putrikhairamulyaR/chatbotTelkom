import React from "react";
import "./LandingPage.css";

export default function LandingPage({ onEnter }) {
  return (
    <div className="landing-container">
      <div className="overlay-box">
        <h1>Learning Management System</h1>
        <p>Silakan baca petunjuk sebelum masuk.</p>

        <button className="btn-enter" onClick={onEnter}>
          Masuk ke Login
        </button>
      </div>
    </div>
  );
}
