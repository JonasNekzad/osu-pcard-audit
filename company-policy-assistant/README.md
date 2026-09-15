# Company Policy Assistant — Render deployment

This is the Render-compatible deployment of the Company Policy Assistant. It compares weighted keyword retrieval, Gemini with the full 98-policy database, and Gemini with five TF-IDF-retrieved policies.

Required Render environment variables:

- `GEMINI_API_KEY` — add as a secret.
- `GEMINI_MODEL` — `gemini-3.5-flash-lite`.

Build command: leave blank. Start command: `npm start`. Health check path: `/api/health`.

The API key is read only by the server and is never sent to the browser.
