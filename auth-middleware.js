// Server-side Google service account auth.
// Uses node:crypto to sign JWTs, swaps for short-lived access tokens.
// Caches tokens in-memory for the lifetime of the serverless function instance.

import crypto from 'node:crypto';

const tokenCache = new Map(); // key: scope|subject  →  { token, exp }

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function getPrivateKey() {
  let key = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!key) throw new Error('GOOGLE_SA_PRIVATE_KEY env var not set');
  // Vercel UI preserves real newlines, but .env files often use literal \n.
  // Handle both.
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return key;
}

export async function getServiceAccountToken({ scope, subject = null } = {}) {
  if (!scope) throw new Error('scope is required');

  const cacheKey = `${scope}|${subject || ''}`;
  const cached = tokenCache.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now < cached.exp - 60) return cached.token;

  const saEmail = process.env.GOOGLE_SA_EMAIL;
  if (!saEmail) throw new Error('GOOGLE_SA_EMAIL env var not set');

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: saEmail,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
    ...(subject ? { sub: subject } : {})
  };

  const headerB64 = b64url(JSON.stringify(header));
  const claimB64 = b64url(JSON.stringify(claim));
  const unsigned = `${headerB64}.${claimB64}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const signature = signer.sign(getPrivateKey());
  const jwt = `${unsigned}.${b64url(signature)}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || 'unknown'}`);
  }
  tokenCache.set(cacheKey, { token: data.access_token, exp: now + (data.expires_in || 3600) });
  return data.access_token;
}
