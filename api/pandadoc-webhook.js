// POST /api/pandadoc-webhook
// PandaDoc calls this when document state changes.
// We listen for "document_state_changed" with status "document.completed"
// (= all parties signed).
//
// Configure in PandaDoc: Workspace settings → Webhooks → Add webhook
//   URL: https://vara-ops-hub.vercel.app/api/pandadoc-webhook
//   Events: document_state_changed
//   Shared key: paste the value of PANDADOC_WEBHOOK_KEY env var
//
// IMPORTANT: This endpoint is PUBLIC (no auth required) — webhooks come from
// PandaDoc's servers, not from logged-in users. We protect it with HMAC
// signature verification using PANDADOC_WEBHOOK_KEY.

import { verifyWebhookSignature, downloadSignedPdf } from '../lib/pandadoc.js';
import { getTenantByPandadocId, transitionStage, saveTenant } from '../lib/tenants.js';
import { resolveTenantFolder, uploadFile } from '../lib/drive.js';

// Vercel: by default they parse JSON. We need raw body for signature verification.
// Setting bodyParser: false gives us the raw stream.
export const config = {
  api: { bodyParser: false }
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-pandadoc-signature'] || req.headers['signature'] || '';

  if (!verifyWebhookSignature(rawBody, signature)) {
    // Don't reveal why — just reject.
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  let events;
  try { events = JSON.parse(rawBody); } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }
  // PandaDoc sends an array of events
  if (!Array.isArray(events)) events = [events];

  const results = [];
  for (const event of events) {
    try {
      const result = await handleEvent(event);
      results.push(result);
    } catch (e) {
      // Log but don't fail the whole batch — PandaDoc retries failed webhooks.
      results.push({ ok: false, error: e.message });
    }
  }

  res.status(200).json({ ok: true, results });
}

async function handleEvent(event) {
  if (event.event !== 'document_state_changed') {
    return { ok: true, skipped: 'not a state_changed event' };
  }
  const data = event.data || {};
  const documentId = data.id;
  const status = data.status;

  if (!documentId) return { ok: true, skipped: 'no document id' };
  if (status !== 'document.completed') {
    // Other intermediate statuses (sent, viewed, etc.) — ignore.
    return { ok: true, skipped: `status: ${status}` };
  }

  // Find the tenant this document belongs to
  const tenant = await getTenantByPandadocId(documentId);
  if (!tenant) {
    // Unknown document. Possibly a race condition (webhook fired before our save
    // committed) or a doc created outside this app. Don't error — just skip.
    return { ok: true, skipped: `unknown document ${documentId}` };
  }
  if (tenant.stage === 'lease_signed' || stageBeyondSigned(tenant.stage)) {
    // Idempotency: already processed.
    return { ok: true, skipped: 'already signed' };
  }

  // 1. Download the signed PDF from PandaDoc
  const pdfBytes = await downloadSignedPdf(documentId);

  // 2. Upload to Drive in the tenant's folder
  const folderId = await resolveTenantFolder(tenant);
  const filename = `Signed Lease — ${tenant.name} — ${tenant.location} ${tenant.suite}.pdf`;
  const file = await uploadFile({
    folderId,
    filename,
    contentType: 'application/pdf',
    body: pdfBytes
  });

  // 3. Update tenant record
  tenant.pandadocSignedAt = new Date().toISOString();
  tenant.leaseDriveFileId = file.id;
  await saveTenant(tenant);
  await transitionStage(tenant, 'lease_signed', 'pandadoc-webhook');

  // Note: we don't send the welcome email from here. That's a separate endpoint
  // the PM triggers (or we wire as a follow-up automation in Phase 2). Reasoning:
  // gives PMs a chance to verify the lease looks right before tenant gets
  // the welcome email + intake form link.

  return { ok: true, tenantId: tenant.id, fileId: file.id };
}

function stageBeyondSigned(stage) {
  return ['form_pending', 'form_submitted', 'processed', 'archived'].includes(stage);
}
