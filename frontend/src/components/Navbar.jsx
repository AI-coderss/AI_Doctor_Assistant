import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import "../styles/Navbar.css";

const THEME_KEY = "theme";

const Navbar = () => {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState("light");
  const navLinksRef = useRef(null);
  const mobileBtnRef = useRef(null);

  const navItems = useMemo(
    () => [
      { to: "/", label: "Home 🏠" },
      { to: "/medical-image-analysis", label: "Medical Image Analysis 🧠" },
    ],
    []
  );

  useEffect(() => {
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    const stored = localStorage.getItem(THEME_KEY);
    const initial = stored || (prefersDark ? "dark" : "light");
    setTheme(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e) => {
      const linksEl = navLinksRef.current;
      const btnEl = mobileBtnRef.current;
      if (
        linksEl &&
        !linksEl.contains(e.target) &&
        btnEl &&
        !btnEl.contains(e.target)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", handleClick);
    return () => document.removeEventListener("click", handleClick);
  }, [menuOpen]);

  const toggleTheme = () => setTheme((t) => (t === "light" ? "dark" : "light"));
  const isActive = (to) => location.pathname === to;

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
          {navItems.map((item, idx) => (
            <Link
              key={item.to}
              to={item.to}
              role="menuitem"
              className={`nav-link ${isActive(item.to) ? "active" : ""}`}
              onClick={() => setMenuOpen(false)}
              style={{
                animation: `navItemFade 0.5s ease forwards ${
                  idx / 7 + 0.3
                }s`,
              }}
            >
              <span>{item.label}</span>
            </Link>
          ))}

          {/* ✅ CHANGE: Theme toggle for the mobile drawer */}
          <button
            className="theme-toggle theme-toggle-mobile"
            aria-label="Toggle theme"
            onClick={toggleTheme}
            type="button"
          >
            <i className="ri-sun-line sun-icon" />
            <i className="ri-moon-line moon-icon" />
          </button>
        </div>

        {/* Actions (right) */}
        <div className="nav-actions">
          {/* ✅ CHANGE: Theme toggle for the desktop view */}
          <button
            className="theme-toggle theme-toggle-desktop"
            aria-label="Toggle theme"
            onClick={toggleTheme}
            type="button"
          >
            <i className="ri-sun-line sun-icon" />
            <i className="ri-moon-line moon-icon" />
          </button>

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


