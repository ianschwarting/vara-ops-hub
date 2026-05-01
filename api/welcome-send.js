// POST /api/welcome-send
// Body: { tenantId }
// Sends welcome email containing the unique intake form link.

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';
import { getTenant, transitionStage, saveTenant } from '../lib/tenants.js';
import { getServiceAccountToken } from '../lib/google-sa.js';

export default requireAuth(async (req, res, session) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { tenantId } = body;
    if (!tenantId) {
      res.status(400).json({ error: 'tenantId required' });
      return;
    }

    const tenant = await getTenant(tenantId);
    if (!tenant) {
      res.status(404).json({ error: 'Tenant not found' });
      return;
    }
    if (tenant.stage !== 'lease_signed' && tenant.stage !== 'form_pending') {
      res.status(409).json({ error: `Cannot send welcome — tenant is in stage "${tenant.stage}"` });
      return;
    }

    const fromEmail = process.env.SUPPORT_EMAIL;
    if (!fromEmail) {
      res.status(500).json({ error: 'SUPPORT_EMAIL not set on server' });
      return;
    }

    // Build the intake URL using the request's host
    const proto = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers.host || 'vara-ops-hub.vercel.app';
    const intakeUrl = `${proto}://${host}/intake/${tenant.intakeToken}`;

    const firstName = tenant.name.split(' ')[0];
    const subject = `Welcome to VARA ${tenant.location} — Next Steps`;
    const emailBody = `Hi ${firstName},

Welcome to VARA Salon Suites! We're excited to have you joining us at our ${tenant.location} location, Suite ${tenant.suite}.

To finish your move-in, please complete this short intake form. It takes about 5 minutes:

${intakeUrl}

You'll be asked to provide:
  • Your driver's license photo
  • Proof of paid deposit
  • Business name, services, and Instagram handle (so we can list you on our website)
  • Your preferred suite door code (if applicable)
  • Sink type confirmation

Once you submit, your property manager will review and finalize everything for your move-in.

Reach out if you have any questions.

The VARA ${tenant.location} Team`;

    // Send via Gmail (same path as existing send-email endpoint)
    const token = await getServiceAccountToken({
      scope: 'https://www.googleapis.com/auth/gmail.send',
      subject: fromEmail
    });

    const fromHeader = `VARA ${tenant.location} <${fromEmail}>`;
    const rawMsg = [
      `From: ${fromHeader}`,
      `To: ${tenant.name} <${tenant.email}>`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      emailBody
    ].join('\r\n');

    const encoded = Buffer.from(rawMsg, 'utf8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encoded })
    });
    const data = await r.json();
    if (!r.ok) {
      res.status(r.status).json({ error: data.error?.message || 'Gmail send failed', detail: data });
      return;
    }

    tenant.welcomeEmailSentAt = new Date().toISOString();
    await transitionStage(tenant, 'form_pending', session.name);

    res.status(200).json({ ok: true, intakeUrl, messageId: data.id });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
