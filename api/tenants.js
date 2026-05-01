// GET  /api/tenants               → list all tenants for the pipeline view
// POST /api/tenants               → create a new tenant (draft stage)

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';
import { listTenants, newTenant, saveTenant } from '../lib/tenants.js';

export default requireAuth(async (req, res, session) => {
  if (req.method === 'GET') {
    try {
      const tenants = await listTenants();
      // Sort: most recently updated first
      tenants.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      res.status(200).json({ tenants });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { name, email, phone, location, suite, leaseStartDate, weeklyRent } = body;
      if (!name || !email || !location || !suite) {
        res.status(400).json({ error: 'name, email, location, and suite are required' });
        return;
      }
      const tenant = newTenant({
        name, email, phone, location, suite, leaseStartDate, weeklyRent,
        createdBy: session.name
      });
      await saveTenant(tenant);
      res.status(201).json({ tenant });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
