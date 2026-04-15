// src/App.js
import React from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import Navbar from "./components/Navbar";
import "./App.css";
import ChatPage from "./pages/ChatPage";
import MedicalImageAnalysisPage from "./pages/MedicalImageAnalysisPage";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";



function Layout({ children }) {
  
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}

function AppRoutes() {
  return (
    <Routes>

      {/* Protected routes */}
      <Route
        path="/"
        element={
        
            <ChatPage />
         
        }
      />
      <Route
        path="/medical-image-analysis"
        element={
      
            <MedicalImageAnalysisPage />
          
        }
      />

      {/* Legacy /chat -> / */}
      <Route path="/chat" element={<Navigate to="/" replace />} />

   
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


