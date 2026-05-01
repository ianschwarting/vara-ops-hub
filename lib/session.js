// Session helpers: HMAC-signed JSON cookies, no external deps.
// Cookie shape:  base64url(JSON payload).base64url(HMAC-SHA256 signature)
// Payload:  { email, name, picture, exp }   (exp = unix seconds)

import crypto from 'node:crypto';

const COOKIE_NAME = 'vara_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  // constant-time compare
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch { return null; }
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function createSessionCookie(payload) {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET env var must be set and at least 32 characters');
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = sign({ ...payload, exp }, secret);
  // HttpOnly: JS can't read this. Secure: HTTPS only. SameSite=Lax: protects against CSRF
  // for state-changing requests but allows top-level navigation.
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(p => p.length === 2)
  );
  return verify(cookies[COOKIE_NAME], secret);
}
