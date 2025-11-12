// src/App.js
import React from "react";
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from "react-router-dom";
import Navbar from "./components/Navbar";
import "./App.css";
import ChatPage from "./pages/ChatPage";
import MedicalImageAnalysisPage from "./pages/MedicalImageAnalysisPage";
import AuthPage from "./pages/AuthPage"; // ⬅️ NEW
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

/** Simple auth helpers */
const isAuthed = () => localStorage.getItem("auth") === "1";

function ProtectedRoute({ children }) {
  return isAuthed() ? children : <Navigate to="/auth" replace />;
}

function Layout({ children }) {
  const location = useLocation();
  const hideNavbar = location.pathname === "/auth";
  return (
    <>
      {!hideNavbar && <Navbar />}
      {children}
    </>
  );
}

function AppRoutes() {
  return (
    <Routes>
      {/* Auth page */}
      <Route path="/auth" element={<AuthPage />} />

      {/* Protected routes */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/medical-image-analysis"
        element={
          <ProtectedRoute>
            <MedicalImageAnalysisPage />
          </ProtectedRoute>
        }
      />

      {/* Legacy /chat -> / */}
      <Route path="/chat" element={<Navigate to="/" replace />} />

      {/* Fallback */}
      <Route
        path="*"
        element={<Navigate to={isAuthed() ? "/" : "/auth"} replace />}
      />
    </Routes>
  );
}

export default function App() {
  return (
    <Router>
      <Layout>
        <AppRoutes />
      </Layout>
      <ToastContainer position="top-right" autoClose={4000} />
    </Router>
  );
}


