// src/pages/AuthPage.jsx
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import "../styles/auth.css";

const TEMP_EMAIL = "m.bahageel88@gmail.com";
const TEMP_PASS = "Bahageel88#";

export default function AuthPage() {
  const [panelRightActive, setPanelRightActive] = useState(false); // false=Sign In view, true=Sign Up view
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const navigate = useNavigate();

  const handleSignIn = (e) => {
    e.preventDefault();
    if (email.trim().toLowerCase() === TEMP_EMAIL && pass === TEMP_PASS) {
      localStorage.setItem("auth", "1");
      setErr("");
      navigate("/");
    } else {
      setErr("Invalid email or password.");
    }
  };

  const handleSignUp = (e) => {
    e.preventDefault();
    // Demo flow: just switch to Sign In after "Sign Up"
    setPanelRightActive(false);
  };

  return (
    <div className="auth-root">
      {/* Waves background */}
      <div className="auth-ocean">
        <div className="auth-wave" />
        <div className="auth-wave second" />
      </div>

      <section className="auth-section">
        {/* ===== Animated text ABOVE the form (outside the card) ===== */}
        <div className="auth-hero" aria-hidden="false">
          <h1 className="hero-head">AI Medical Assistant</h1>
          <div className="hero-rotator" role="status" aria-live="polite">
            <span className="line l1">Fast, accurate, always-on.</span>
            <span className="line l2">Triage, summaries, and notes — simplified.</span>
            <span className="line l3">Secure, integrated, built for real use.</span>
          </div>
        </div>

        {/* ===== Centered auth card, wider on desktop, same shape on mobile ===== */}
        <div
          id="auth-shell"
          className={`auth-shell ${panelRightActive ? "is-signup" : ""}`}
        >
          {/* Sign Up */}
          <div className="auth-form auth-signup">
            <form onSubmit={handleSignUp}>
              <h1>Create Account</h1>

              <div className="auth-socials">
                <a
                  className="auth-social"
                  href="https://github.com/farazc60"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-hidden="true">
                    <path fill="currentColor" d="M12 .5A12 12 0 0 0 0 12.6c0 5.3 3.4 9.7 8.2 11.3c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6c-.6-1.6-1.5-2-1.5-2c-1.2-.8.1-.8.1-.8c1.3.1 2 .9 2 .9c1.1 2 3 1.4 3.7 1.1c.1-.8.4-1.4.8-1.8c-2.7-.4-5.6-1.4-5.6-6.2c0-1.4.5-2.5 1.2-3.4c-.1-.4-.5-1.7.1-3.5c0 0 1-.3 3.4 1.3A11.2 11.2 0 0 1 12 5.6c1 0 2-.1 2.9-.4c2.4-1.6 3.4-1.3 3.4-1.3c.6 1.8.2 3.1.1 3.5c.8.9 1.2 2 1.2 3.4c0 4.9-2.9 5.8-5.6 6.2c.5.4.9 1.1.9 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 24 12.6A12 12 0 0 0 12 .5"/>
                  </svg>
                </a>
                <a
                  className="auth-social"
                  href="https://codepen.io/codewithfaraz"
                  target="_blank"
                  rel="noreferrer"
                  aria-label="CodePen"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-hidden="true">
                    <path fill="currentColor" d="m21.438 8.156l-9-6a1.5 1.5 0 0 0-1.688 0l-9 6A1.5 1.5 0 0 0 1 9.406v5.188a1.5 1.5 0 0 0 .75 1.281l9 6a1.5 1.5 0 0 0 1.5 0l9-6A1.5 1.5 0 0 0 23 14.594V9.406a1.5 1.5 0 0 0-.75-1.25zM12 3.219L20.063 8L16.5 10.375L12 7.375zm-8.063 4.78L12 3.219v4.156l-4.5 3zm-1.438 6.594V9.406l3.562 2.375v2.438zm9.5 6.188l-8.063-5.28L7.5 13.625L12 16.625zm1 0v-3.594l4.5-3l4.063 2.75zM20.5 14.22l-3.563-2.438v-2.406L20.5 8.5z"/>
                  </svg>
                </a>
                <a className="auth-social" href="mailto:farazc60@gmail.com" aria-label="Email">
                  <svg width="18" height="18" viewBox="0 0 24 24" role="img" aria-hidden="true">
                    <path fill="currentColor" d="M12 12.713L.015 3.6C.061 2.67.8 2 1.733 2h20.534c.932 0 1.672.67 1.717 1.6L12 12.713zm-.74 1.18L0 4.86V20.27C0 21.2.8 22 1.733 22h20.534A1.73 1.73 0 0 0 24 20.27V4.86l-11.26 9.033a1.999 1.999 0 0 1-2.48 0z"/>
                  </svg>
                </a>
              </div>

              <span>Or use your email for registration</span>

              <label className="auth-label">
                <input className="auth-input" type="text" placeholder="Name" required />
              </label>
              <label className="auth-label">
                <input className="auth-input" type="email" placeholder="Email" required />
              </label>
              <label className="auth-label">
                <input className="auth-input" type="password" placeholder="Password" required />
              </label>

              <button className="auth-btn" style={{ marginTop: 9 }}>Sign Up</button>
            </form>
          </div>

          {/* Sign In */}
          <div className="auth-form auth-signin">
            <form onSubmit={handleSignIn}>
              <h1>Sign In</h1>

              <div className="auth-socials">
                {/* same icons for layout balance */}
                <span className="auth-social muted">GH</span>
                <span className="auth-social muted">CP</span>
                <span className="auth-social muted">@</span>
              </div>

              <span>Or sign in with your email</span>

              <label className="auth-label">
                <input
                  className="auth-input"
                  type="email"
                  placeholder="Email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label className="auth-label">
                <input
                  className="auth-input"
                  type="password"
                  placeholder="Password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  required
                />
              </label>

              <a className="auth-forgot" href="#forgot">Forgot your password?</a>

              {err && <div className="auth-error" role="alert">{err}</div>}

              <button className="auth-btn">Sign In</button>
            </form>
          </div>

          {/* Overlay */}
          <div className="auth-overlay-wrap">
            <div className="auth-overlay">
              <div className="auth-overlay-panel left">
                <h1>Welcome Back</h1>
                <p>Sign in if you already have an account.</p>
                <button className="auth-btn ghost mt-5" onClick={() => setPanelRightActive(false)}>
                  Sign In
                </button>
              </div>
              <div className="auth-overlay-panel right">
                <h1>Create Account</h1>
                <p>Sign up if you don’t have an account yet.</p>
                <button className="auth-btn ghost" onClick={() => setPanelRightActive(true)}>
                  Sign Up
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
