import React from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Navbar from "./components/Navbar";
import "./App.css";
import ChatPage from "./pages/ChatPage";
import MedicalImageAnalysisPage from "./pages/MedicalImageAnalysisPage";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

function App() {
  return (
    <Router>
      <Navbar />
      <Routes>
        {/* Home = Chat */}
        <Route path="/" element={<ChatPage />} />
        {/* Medical Image Analysis */}
        <Route path="/medical-image-analysis" element={<MedicalImageAnalysisPage />} />
        {/* (Optional) keep /chat working by redirecting to / */}
        <Route path="/chat" element={<Navigate to="/" replace />} />
        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <ToastContainer position="top-right" autoClose={4000} />
    </Router>
  );
}

export default App;

