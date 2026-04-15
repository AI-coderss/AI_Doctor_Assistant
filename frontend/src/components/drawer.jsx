import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FaBars, FaTimes } from "react-icons/fa";

const DrawComponent = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);

  // close from external events
  useEffect(() => {
    const close = () => setIsOpen(false);
    window.addEventListener("tools:close", close);
    window.addEventListener("close-tools-drawer", close);

    return () => {
      window.removeEventListener("tools:close", close);
      window.removeEventListener("close-tools-drawer", close);
    };
  }, []);

  // ✅ Auto-close when clicking any tool inside
  const enhancedChildren = React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;

    return React.cloneElement(child, {
      onClick: (e) => {
        child.props?.onClick?.(e);
        setIsOpen(false);
      },
    });
  });

  return (
    <>
      {/* Sidebar */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ x: -120, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -120, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            style={{
              position: "fixed",
              top: "80px", // 👈 below navbar
              left: "20px",
              width: "340px", // 👈 increased width
              height: "88vh", // 👈 increased height
              zIndex: 9998,

              display: "flex",
              flexDirection: "column",
              padding: "18px",

              borderRadius: "18px",

              // ✅ Clean glass (works in light + dark)
              background: "rgba(20, 20, 30, 0.55)",
              backdropFilter: "blur(16px)",
              WebkitBackdropFilter: "blur(16px)",

              border: "1px solid rgba(255,255,255,0.08)",
              boxShadow: "0 10px 40px rgba(0,0,0,0.25)",

              overflowY: "auto",
              gap: "12px",
            }}
          >
            {/* optional header */}
            <div
              style={{
                fontSize: "12px",
                letterSpacing: "1px",
                color: "rgba(255,255,255,0.6)",
                marginBottom: "6px",
                fontWeight: 600,
              }}
            >
              TOOLS
            </div>

            {/* Tools */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "12px",
              }}
            >
              {enhancedChildren}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Hamburger Button */}
      <button
        onClick={() => setIsOpen((p) => !p)}
        style={{
          position: "fixed",
          top: "22px",
          left: "20px",
          zIndex: 9999,

          width: "46px",
          height: "46px",
          borderRadius: "12px",
          border: "1px solid rgba(255,255,255,0.15)",
          cursor: "pointer",

          display: "flex",
          alignItems: "center",
          justifyContent: "center",

          background: "rgba(20,20,30,0.65)",
          backdropFilter: "blur(12px)",

          color: "white",
          boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
        }}
      >
        {isOpen ? <FaTimes size={18} /> : <FaBars size={18} />}
      </button>
    </>
  );
};

export default DrawComponent;