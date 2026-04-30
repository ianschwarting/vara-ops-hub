// POST /api/send-email
// Body: { to, subject, body }
// Sends from SUPPORT_EMAIL via Gmail API.

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';
import { getServiceAccountToken } from '../lib/google-sa.js';

export default requireAuth(async (req, res, session) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const fromEmail = process.env.SUPPORT_EMAIL;
  if (!fromEmail) {
    res.status(500).json({ error: 'SUPPORT_EMAIL not set on server' });
    return;
  }

  const body = await readJsonBody(req);
  const { to, subject, body: messageBody, fromName } = body;
  if (!to || !subject || !messageBody) {
    res.status(400).json({ error: 'to, subject, and body are required' });
    return;
  }

  try {
    const token = await getServiceAccountToken({
      scope: 'https://www.googleapis.com/auth/gmail.send',
      subject: fromEmail
    });

    const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
    const rawMsg = [
      `From: ${fromHeader}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      ``,
      messageBody
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
    res.status(200).json({ ok: true, messageId: data.id, sentBy: session.name });
  } catch (e) {
    res.status(502).json({ error: 'Email send failed: ' + e.message });
  }
});
