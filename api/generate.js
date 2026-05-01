// POST /api/generate
// Body: { mode: 'on'|'off', tenant: {...}, locationCount: number }
// Returns: { welcome_email, pm_notes, raw }

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';

export default requireAuth(async (req, res, session) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
    return;
  }

  const body = await readJsonBody(req);
  const { mode = 'on', tenant = {}, locationCount = 18 } = body;
  if (!tenant.name || !tenant.location || !tenant.suite) {
    res.status(400).json({ error: 'tenant.name, tenant.location, and tenant.suite are required' });
    return;
  }

  const isOn = mode === 'on';
  const system = `You are an operations assistant for VARA Salon Suites, a growing salon suites business with ${locationCount} locations. Generate professional, warm, and concise output. Return ONLY these XML tags with content inside, nothing else:
<welcome_email>...</welcome_email>
<pm_notes>...</pm_notes>

The email should be warm, professional, ready to send. Sign off as "The VARA ${tenant.location} Team".
PM notes should be 2-3 bullet points flagging anything unusual or requiring attention.`;

  const prompt = isOn
    ? `Generate an onboarding package for:
Tenant: ${tenant.name}${tenant.biz ? ` (${tenant.biz})` : ''}
Location: ${tenant.location} — Suite ${tenant.suite}
Move-in date: ${tenant.date || 'TBD'}
Email: ${tenant.email || 'not provided'} | Phone: ${tenant.phone || 'not provided'}
Weekly rent: ${tenant.rent || 'TBD'}
Services: ${tenant.services || 'not specified'}
Notes: ${tenant.notes || 'none'}`
    : `Generate an offboarding package for a departing tenant:
Tenant: ${tenant.name}${tenant.biz ? ` (${tenant.biz})` : ''}
Location: ${tenant.location} — Suite ${tenant.suite}
Move-out date: ${tenant.date || 'TBD'}
Email: ${tenant.email || 'not provided'} | Phone: ${tenant.phone || 'not provided'}
Notes: ${tenant.notes || 'none'}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: data.error?.message || 'Anthropic API error', detail: data });
      return;
    }
    const text = data.content?.map(b => b.text || '').join('') || '';
    const extract = tag => {
      const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : null;
    };
    res.status(200).json({
      welcome_email: extract('welcome_email'),
      pm_notes: extract('pm_notes'),
      raw: text
    });
  } catch (e) {
    res.status(502).json({ error: 'Failed to reach Anthropic: ' + e.message });
  }
});
