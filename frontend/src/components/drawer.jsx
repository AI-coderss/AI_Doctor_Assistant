import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FaBars, FaTimes } from "react-icons/fa";

const DrawComponent = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const close = () => setIsOpen(false);
    window.addEventListener("tools:close", close);
    window.addEventListener("close-tools-drawer", close);
    return () => {
      window.removeEventListener("tools:close", close);
      window.removeEventListener("close-tools-drawer", close);
    };
  }, []);

  // ✅ Force clean layout + auto close
  const cleanChildren = React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;

    return (
      <div
        onClick={() => setIsOpen(false)}
        style={{
          width: "100%",
          padding: "10px",
          borderRadius: "14px",
          background: "rgba(255,255,255,0.65)",
          border: "1px solid rgba(0,0,0,0.05)",
          backdropFilter: "blur(6px)",
        }}
      >
        {child}
      </div>
    );
  });

  return (
    <>
      {/* Sidebar */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: -150, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -150, opacity: 0 }}
            transition={{ duration: 0.25 }}
            style={{
              position: "fixed",
              top: "85px", // below navbar
              left: "20px",
              width: "380px", // ✅ wider
              height: "82vh", // ✅ controlled height
              zIndex: 9998,

              padding: "18px",
              display: "flex",
              flexDirection: "column",
              gap: "14px",

              borderRadius: "20px",

              // ✅ CLEAN LIGHT GLASS (not gray)
              background: "rgba(255,255,255,0.75)",
              backdropFilter: "blur(18px)",
              WebkitBackdropFilter: "blur(18px)",

              border: "1px solid rgba(0,0,0,0.08)",
              boxShadow: "0 10px 30px rgba(0,0,0,0.12)",

              overflow: "hidden", // ❌ no scrollbar
            }}
          >
            {/* Header */}
            <div
              style={{
                fontWeight: "600",
                fontSize: "14px",
                color: "#333",
                marginBottom: "6px",
              }}
            >
              Tools Panel
            </div>

            {/* Content */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                overflow: "hidden",
              }}
            >
              {cleanChildren}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toggle */}
      <button
        onClick={() => setIsOpen((p) => !p)}
        style={{
          position: "fixed",
          top: "20px",
          left: "20px",
          zIndex: 9999,

          width: "48px",
          height: "48px",
          borderRadius: "12px",
          border: "1px solid rgba(0,0,0,0.1)",

          display: "flex",
          alignItems: "center",
          justifyContent: "center",

          background: "white", // ✅ visible in light mode
          color: "#222",

          cursor: "pointer",
          boxShadow: "0 6px 18px rgba(0,0,0,0.15)",
        }}
      >
        {isOpen ? <FaTimes size={18} /> : <FaBars size={18} />}
      </button>
    </>
  );
};

export default DrawComponent;