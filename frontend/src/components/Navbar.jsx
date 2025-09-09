import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import "../styles/Navbar.css";
import "../styles/Specialty.css";
import SpecialtyHomeMenu from "./SpecialtyHomeMenu";

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
  const [menuOpen, setMenuOpen] = useState(false);

  // 🚫 No initial "light" flash: pick & apply BEFORE first paint
  const [theme, setTheme] = useState(() => {
    const initial = readStoredTheme();
    applyTheme(initial);
    return initial;
  });

  const navLinksRef = useRef(null);
  const mobileBtnRef = useRef(null);

  // NEW: programmatic close state for the Home dropdown
  const [homeForceClose, setHomeForceClose] = useState(false);
  const homeRef = useRef(null);

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

  // When a specialty is picked, force-close the hover menu briefly
  const handleMenuPicked = () => {
    // blur any focused element to end :focus-within visibility
    try { document.activeElement?.blur?.(); } catch {}
    setHomeForceClose(true);
    // After transition time, allow hovering again
    setTimeout(() => setHomeForceClose(false), 220);
  };

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
          {/* Home: multi-level dropdown */}
          <div
            ref={homeRef}
            className={`home-dd ${isActive("/") ? "active" : ""} ${homeForceClose ? "force-close" : ""}`}
            onMouseLeave={() => setHomeForceClose(false)}
          >
            {/* Prevent navigation; dropdown opens on hover/focus */}
            <Link
              to="/"
              role="menuitem"
              className={`nav-link home-trigger ${isActive("/") ? "active" : ""}`}
              onClick={(e) => e.preventDefault()}
            >
              <span>Home 🏠</span>
            </Link>

            {/* Multi-level dropdown */}
            <SpecialtyHomeMenu onPicked={handleMenuPicked} />
          </div>

          {/* Other nav items */}
          {navItems.slice(1).map((item, idx) => (
            <Link
              key={item.to}
              to={item.to}
              role="menuitem"
              className={`nav-link ${isActive(item.to) ? "active" : ""}`}
              onClick={() => setMenuOpen(false)}
              style={{ animation: `navItemFade 0.5s ease forwards ${idx / 7 + 0.3}s` }}
            >
              <span>{item.label}</span>
            </Link>
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
        </div>

        {/* Actions (right) */}
        <div className="nav-actions">
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







