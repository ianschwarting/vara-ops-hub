// Wrap an API handler so it only runs for logged-in users.
// Usage:  export default requireAuth(async (req, res, session) => { ... })

import { readSession } from './session.js';

export function requireAuth(handler) {
  return async (req, res) => {
    const session = readSession(req);
    if (!session) {
      res.status(401).json({ error: 'Not authenticated. Please sign in again.' });
      return;
    }
    return handler(req, res, session);
  };
}

// JSON body parsing helper (Vercel parses JSON automatically when Content-Type is set,
// but this guards against edge cases).
export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body) {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Fallback for raw streams
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
