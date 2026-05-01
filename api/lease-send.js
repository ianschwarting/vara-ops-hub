// POST /api/lease-send
// Body: { tenantId }
// Creates a PandaDoc document from the lease template and sends it to the tenant.

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';
import { getTenant, transitionStage, saveTenant } from '../lib/tenants.js';
import { createLeaseFromTemplate, waitForDocumentReady, sendDocument } from '../lib/pandadoc.js';

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
    if (tenant.stage !== 'draft' && tenant.stage !== 'lease_sent') {
      // Allow re-send if still in lease_sent (e.g. tenant lost the email).
      // Block if already signed/processed.
      res.status(409).json({ error: `Cannot send lease — tenant is in stage "${tenant.stage}"` });
      return;
    }
    if (!tenant.email) {
      res.status(400).json({ error: 'Tenant has no email — cannot send lease' });
      return;
    }

    // 1. Create document from template
    const doc = await createLeaseFromTemplate({ tenant });
    tenant.pandadocDocumentId = doc.id;
    await saveTenant(tenant);  // persist mapping immediately so webhooks can find it

    // 2. Wait for PandaDoc to finish processing
    await waitForDocumentReady(doc.id);

    // 3. Send to recipient
    await sendDocument(doc.id, {
      subject: `Your VARA ${tenant.location} Lease — Please Sign`,
      message: `Hi ${tenant.name.split(' ')[0]},\n\nWelcome to VARA Salon Suites! Your lease for Suite ${tenant.suite} at our ${tenant.location} location is ready for your review and signature.\n\nLet us know if anything needs adjusting before you sign.\n\nThe VARA ${tenant.location} Team`
    });

    tenant.pandadocSentAt = new Date().toISOString();
    await transitionStage(tenant, 'lease_sent', session.name);

    res.status(200).json({ ok: true, documentId: doc.id, stage: tenant.stage });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
