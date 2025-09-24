/* eslint-disable no-unused-vars */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import "../styles/Navbar.css";
import "../styles/Specialty.css";

import LabResultsUploader from "./LabResultsUploader";

const THEME_KEY = "theme";

// Safely read user's stored theme or fall back to system
function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "dark" || v === "light") return v;
  } catch (_e) {}
  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  return prefersDark ? "dark" : "light";
}

// Apply theme to the root immediately & consistently
function applyTheme(t) {
  const root = document.documentElement;
  root.setAttribute("data-theme", t);
  root.style.colorScheme = t;
  document.body?.setAttribute("data-theme", t);
}

const Navbar = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const [menuOpen, setMenuOpen] = useState(false);

  // 🚫 No initial "light" flash: pick & apply BEFORE first paint
  const [theme, setTheme] = useState(() => {
    const initial = readStoredTheme();
    applyTheme(initial);
    return initial;
  });

  const [isSmall, setIsSmall] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 900px)").matches
      : false
  );

  useEffect(() => {
    const mq = window.matchMedia?.("(max-width: 900px)");
    if (!mq) return;
    const handler = (e) => setIsSmall(e.matches);
    try {
      mq.addEventListener("change", handler);
    } catch {
      // Safari fallback
      mq.addListener(handler);
    }
    return () => {
      try {
        mq.removeEventListener("change", handler);
      } catch {
        mq.removeListener(handler);
      }
    };
  }, []);

  const navLinksRef = useRef(null);
  const mobileBtnRef = useRef(null);

  const navItems = useMemo(
    () => [
      { to: "/", label: "Home 🏠" },
      { to: "/medical-image-analysis", label: "Medical Image Analysis 🧠" },
    ],
    []
  );

  // Persist on change & re-apply to be extra sure
  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch (_e) {}
    applyTheme(theme);
  }, [theme]);

  // Close mobile menu on route change
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);

  // Click-outside to close mobile drawer
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      const linksEl = navLinksRef.current;
      const btnEl = mobileBtnRef.current;
      if (linksEl && !linksEl.contains(e.target) && btnEl && !btnEl.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen]);

  // Sync theme across tabs/windows
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === THEME_KEY && (e.newValue === "dark" || e.newValue === "light")) {
        setTheme(e.newValue);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  const isActive = (to) => location.pathname === to;

  // ---- Smooth Back navigation (with fallback) ----
  const canGoBack = typeof window !== "undefined" ? window.history.length > 1 : false;
  const goBack = () => {
    if (canGoBack) {
      navigate(-1);
    } else {
      // fallback to Home if there's no history entry
      navigate("/", { replace: true });
    }
  };
  // -----------------------------------------------

  return (
    <nav className="premium-nav" role="navigation" aria-label="Main Navigation">
      <div className="nav-container">
        {/* Logo (left) */}
        <Link to="/" className="nav-logo" aria-label="Premium Home">
          <span className="logo-text">AI Doctor Assistant</span>
          <div className="logo-shine" />
        </Link>

        {/* Links (center) & Mobile Drawer Content */}
        <div
          ref={navLinksRef}
          className={`nav-links ${menuOpen ? "active" : ""}`}
          role="menubar"
          aria-label="Primary"
        >
          {/* Core nav items */}
          {navItems.map((item, idx) => (
            <NavLink
              key={item.to}
              to={item.to}
              role="menuitem"
              className={({ isActive: act }) =>
                `nav-link ${act ? "active" : ""}`
              }
              onClick={() => setMenuOpen(false)}
              style={{ animation: `navItemFade 0.5s ease forwards ${idx / 7 + 0.2}s` }}
            >
              <span>{item.label}</span>
            </NavLink>
          ))}

          {/* Theme toggle in mobile drawer */}
          <button
            className="theme-toggle theme-toggle-mobile"
            aria-label="Toggle theme"
            aria-pressed={theme === "dark"}
            onClick={toggleTheme}
            type="button"
          >
            <i className="ri-sun-line sun-icon" />
            <i className="ri-moon-line moon-icon" />
          </button>

          {/* --- MOBILE-ONLY: Lab Uploader inside hamburger dropdown --- */}
          {isSmall && menuOpen && (
            <div
              className="nav-mobile-uploader"
              style={{
                marginTop: 14,
                paddingTop: 10,
                borderTop: "1px solid var(--border, rgba(0,0,0,.08))",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <strong style={{ fontSize: 14 }}>
                  📎 Carica referti (OCR)
                </strong>
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                  PDF/Immagini
                </span>
              </div>

              {/* Embed uploader in dense mode; positioned statically & compact via CSS */}
              <LabResultsUploader
                dense
                className="lab-uploader-embedded"
                style={{
                  position: "static",
                  width: "100%",
                  zIndex: "auto",
                }}
                autoSend={true}
                ocrLanguage="eng"   // "ara" for Arabic
                engine="2"
                onBeforeSendToAI={(text, meta) =>
                  [
                    "You are a clinical AI assistant.",
                    "You are given OCR-extracted lab results below.",
                    "Summarize abnormal values (with units), compare to provided normal ranges, flag critical values,",
                    "and give a concise, guideline-aligned interpretation.",
                    `SOURCE FILE: ${meta?.filename || "Unknown"}`,
                    "",
                    "=== LAB RESULTS (OCR) ===",
                    text,
                  ].join("\n")
                }
              />
            </div>
          )}
        </div>

        {/* Actions (right) */}
        <div className="nav-actions">
          {/* Back button (smooth return) */}
          <button
            className="nav-back-btn"
            aria-label="Torna indietro"
            onClick={goBack}
            type="button"
            disabled={!canGoBack && location.pathname === "/"}
            title="Indietro"
          >
            <i className="ri-arrow-left-line" />
          </button>

          {/* Theme toggle (desktop) */}
          <button
            className="theme-toggle theme-toggle-desktop"
            aria-label="Toggle theme"
            aria-pressed={theme === "dark"}
            onClick={toggleTheme}
            type="button"
          >
            <i className="ri-sun-line sun-icon" />
            <i className="ri-moon-line moon-icon" />
          </button>

          {/* Hamburger */}
          <button
            ref={mobileBtnRef}
            className="mobile-menu"
            aria-label="Menu"
            aria-expanded={menuOpen ? "true" : "false"}
            onClick={() => setMenuOpen((v) => !v)}
            type="button"
          >
            <i className={menuOpen ? "ri-close-line" : "ri-menu-line"} />
          </button>
        </div>
      </div>
    </nav>
  );
};

export default Navbar;









