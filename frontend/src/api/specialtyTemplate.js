// src/api/specialtyTemplate.js

const BASE =
  process.env.REACT_APP_BACKEND_BASE_URL ||
  "https://ai-doctor-assistant-backend-server.onrender.com";

/**
 * Fetch a form schema for the selected specialty.
 * Server: GET /template-form-schema?specialty=...
 * Returns: { specialty, schema: {...} }
 */
export async function getFormSchema(specialty) {
  if (!specialty) throw new Error("Specialty is required");
  const res = await fetch(
    `${BASE}/template-form-schema?specialty=${encodeURIComponent(specialty)}`,
    { method: "GET" }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to get form schema (${res.status}): ${text || res.statusText}`
    );
  }
  return res.json();
}

/**
 * Compose a plain-text prompt from a submitted form (no JSON in output).
 * Server: POST /compose-form-prompt
 * Body: { specialty, session_id?, form: {...} }
 * Returns: { prompt: "..." }
 */
export async function composeFormPrompt({ specialty, sessionId, form }) {
  if (!specialty) throw new Error("Specialty is required");
  const res = await fetch(`${BASE}/compose-form-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      specialty,
      session_id: sessionId,
      form: form || {},
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to compose prompt (${res.status}): ${text || res.statusText}`
    );
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/* Back-compat shims so older components (e.g., SpecialtyHomeMenu.jsx) */
/* keep compiling while we transition to form-based intake.            */
/* ------------------------------------------------------------------ */

/**
 * generateTemplate(sessionId, specialty)
 * Old flow expected a JSON "template". We’re in form-mode now, so we simply
 * return a stub that signals the UI there’s nothing to render as JSON.
 */
export async function generateTemplate(_sessionId, _specialty) {
  return { template: "__form_mode__" };
}

/**
 * activateTemplate(sessionId, specialty, template)
 * In form-mode there’s nothing to activate server-side. We return ok:true.
 * If you later add a real activation endpoint, hook it up here.
 */
export async function activateTemplate(_sessionId, _specialty, _template) {
  return { ok: true };
}

/**
 * Optional convenience if some places call a deactivation API.
 */
export async function deactivateTemplate(_sessionId) {
  return { ok: true };
}

export { BASE as __SPECIALTY_API_BASE__ };
