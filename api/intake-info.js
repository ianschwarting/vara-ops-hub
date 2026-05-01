// GET /api/intake-info?token=xxx
// PUBLIC endpoint — no auth. Returns the pre-fill data for the intake form
// based on the unique token in the welcome email URL.
//
// Returns only what the tenant should know about themselves. We never expose
// internal fields like createdBy, history, pandadoc IDs, etc.

import { getTenantByIntakeToken } from '../lib/tenants.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = req.query.token;
  if (!token) {
    res.status(400).json({ error: 'token required' });
    return;
  }

  try {
    const tenant = await getTenantByIntakeToken(token);
    if (!tenant) {
      res.status(404).json({ error: 'Invalid or expired link.' });
      return;
    }

    if (tenant.stage === 'processed' || tenant.stage === 'archived') {
      res.status(410).json({ error: 'This intake form has already been completed and processed.' });
      return;
    }

    // Strip internal fields. Only send back what the tenant provided or needs to see.
    res.status(200).json({
      name: tenant.name,
      email: tenant.email,
      phone: tenant.phone,
      location: tenant.location,
      suite: tenant.suite,
      alreadySubmitted: tenant.stage === 'form_submitted'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
