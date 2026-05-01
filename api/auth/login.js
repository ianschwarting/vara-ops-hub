// POST /api/auth/login
// Body: { password, name }
// Compares password to HUB_PASSWORD env var (constant-time), sets signed session cookie.

import crypto from 'node:crypto';
import { createSessionCookie } from '../../lib/session.js';
import { readJsonBody } from '../../lib/auth-middleware.js';

// Simple in-memory rate limit per serverless instance.
// Not bulletproof (Vercel spins up multiple instances) but raises the bar
// against casual brute-force from a single source.
const failuresByIp = new Map(); // ip -> { count, resetAt }
const MAX_FAILURES = 10;
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function getIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = failuresByIp.get(ip);
  if (!entry || entry.resetAt < now) {
    failuresByIp.set(ip, { count: 0, resetAt: now + WINDOW_MS });
    return true;
  }
  return entry.count < MAX_FAILURES;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = failuresByIp.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  entry.count++;
  failuresByIp.set(ip, entry);
}

function constantTimeEquals(a, b) {
  // Both must be strings. crypto.timingSafeEqual requires equal-length buffers,
  // so we hash both first to ensure constant length comparison regardless of input.
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const expected = process.env.HUB_PASSWORD;
  if (!expected) {
    res.status(500).json({ error: 'Server misconfigured: HUB_PASSWORD not set' });
    return;
  }

  const ip = getIp(req);
  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { password, name } = body;
    if (!password) {
      res.status(400).json({ error: 'Password required' });
      return;
    }

    if (!constantTimeEquals(password, expected)) {
      recordFailure(ip);
      res.status(401).json({ error: 'Incorrect password' });
      return;
    }

    // Sanitize the name. It's not security — just defends against weird inputs.
    const cleanName = String(name || 'Property Manager').trim().substring(0, 60) || 'Property Manager';

    res.setHeader('Set-Cookie', createSessionCookie({ name: cleanName }));
    res.status(200).json({ ok: true, name: cleanName });
  } catch (e) {
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
}
