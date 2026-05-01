// PandaDoc API client.
// Docs: https://developers.pandadoc.com/reference/about
//
// Auth: API key in Authorization: API-Key {key} header.
// Workflow:
//   1. POST /documents  with template_uuid + recipients + tokens (merge field values)
//      → returns document.id, status: 'document.uploaded' (still processing)
//   2. Poll GET /documents/{id} until status: 'document.draft' (a few seconds)
//   3. POST /documents/{id}/send  to email it to the recipient
//   4. PandaDoc fires webhook 'recipient_completed' or 'document_state_changed'
//      when tenant signs.

const PD_BASE = 'https://api.pandadoc.com/public/v1';

function authHeader() {
  const key = process.env.PANDADOC_API_KEY;
  if (!key) throw new Error('PANDADOC_API_KEY not set on server');
  return `API-Key ${key}`;
}

async function pdFetch(path, options = {}) {
  const r = await fetch(`${PD_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': authHeader(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let err;
    try { err = JSON.parse(text); } catch { err = { detail: text }; }
    throw new Error(`PandaDoc ${path}: ${err.detail || err.message || r.status}`);
  }
  // Some endpoints (send) return 200 with no body
  const text = await r.text();
  return text ? JSON.parse(text) : {};
}

// ─── Create + send a lease document from a template ─────────────────────────

export async function createLeaseFromTemplate({ tenant }) {
  const templateId = process.env.PANDADOC_LEASE_TEMPLATE_ID;
  if (!templateId) throw new Error('PANDADOC_LEASE_TEMPLATE_ID not set on server');

  const [first, ...rest] = (tenant.name || '').split(' ');
  const last = rest.join(' ') || first;

  const payload = {
    name: `Lease — ${tenant.name} — ${tenant.location} Suite ${tenant.suite}`,
    template_uuid: templateId,
    recipients: [{
      email: tenant.email,
      first_name: first,
      last_name: last,
      role: 'Tenant'   // must match the role name in your PandaDoc template
    }],
    // Tokens are merge field values. Names here must match the {{token_name}}
    // placeholders in your PandaDoc template exactly.
    tokens: [
      { name: 'tenant_name', value: tenant.name },
      { name: 'tenant_email', value: tenant.email },
      { name: 'tenant_phone', value: tenant.phone || '' },
      { name: 'location', value: tenant.location },
      { name: 'suite', value: tenant.suite },
      { name: 'lease_start_date', value: tenant.leaseStartDate || '' },
      { name: 'weekly_rent', value: tenant.weeklyRent || '' }
    ],
    metadata: {
      tenant_id: tenant.id  // so we can correlate webhooks back even without our lookup table
    }
  };

  return pdFetch('/documents', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// PandaDoc takes a few seconds to "process" a document after creation.
// We poll until status === 'document.draft' (max ~30s).
export async function waitForDocumentReady(documentId, maxAttempts = 15) {
  for (let i = 0; i < maxAttempts; i++) {
    const doc = await pdFetch(`/documents/${documentId}`);
    if (doc.status === 'document.draft') return doc;
    if (doc.status === 'document.error' || doc.status === 'document.rejected') {
      throw new Error(`PandaDoc document failed processing: ${doc.status}`);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('PandaDoc document did not become ready within 30s');
}

export async function sendDocument(documentId, { subject, message } = {}) {
  return pdFetch(`/documents/${documentId}/send`, {
    method: 'POST',
    body: JSON.stringify({
      subject: subject || 'Your VARA Salon Suites Lease — Please Sign',
      message: message || 'Please review and sign your lease. Reach out if anything looks off.',
      silent: false
    })
  });
}

// Download a signed document as PDF bytes.
export async function downloadSignedPdf(documentId) {
  // GET /documents/{id}/download — returns binary PDF
  const r = await fetch(`${PD_BASE}/documents/${documentId}/download`, {
    headers: { 'Authorization': authHeader() }
  });
  if (!r.ok) throw new Error(`PandaDoc download failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Verify webhook signatures. PandaDoc signs with HMAC-SHA256 using your shared key.
// Returns true if valid, false otherwise.
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PANDADOC_WEBHOOK_KEY;
  if (!secret) {
    // If no webhook key configured, fail closed in production. For local dev,
    // you might want to allow bypass — but in the cloud, no key = no trust.
    return false;
  }
  const crypto = require('node:crypto');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!signatureHeader) return false;
  // Constant-time compare
  if (expected.length !== signatureHeader.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
}
