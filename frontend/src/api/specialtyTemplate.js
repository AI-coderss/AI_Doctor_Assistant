// src/api/specialtyTemplate.js
const API_BASE = "https://ai-doctor-assistant-backend-server.onrender.com";

export async function generateTemplate(sessionId, specialty) {
  const r = await fetch(`${API_BASE}/specialty-template/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, specialty })
  });
  return r.json();
}

export async function activateTemplate(sessionId, specialty, template) {
  const r = await fetch(`${API_BASE}/specialty-template/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, specialty, template })
  });
  return r.json();
}

export async function deactivateTemplate(sessionId) {
  const r = await fetch(`${API_BASE}/specialty-template/deactivate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId })
  });
  return r.json();
}
