// POST /api/buildium
// Body: { action: 'create', tenant: { name, email, phone, location, suite, date } }

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';

const BUILDIUM_BASE = 'https://api.buildium.com/v1';

function buildiumHeaders() {
  const id = process.env.BUILDIUM_CLIENT_ID;
  const secret = process.env.BUILDIUM_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Buildium credentials not set on server');
  return {
    'x-buildium-client-id': id,
    'x-buildium-client-secret': secret,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };
}

async function resolveIds(locationName, unitNumber) {
  const propsRes = await fetch(`${BUILDIUM_BASE}/rentals?limit=200`, { headers: buildiumHeaders() });
  if (!propsRes.ok) throw new Error(`Buildium properties fetch failed: ${propsRes.status}`);
  const props = await propsRes.json();
  const target = locationName.trim().toLowerCase();
  const property = props.find(p => {
    const name = (p.Name || '').toLowerCase();
    return name === target || name.includes(target) || target.includes(name.split(' ').pop());
  });
  if (!property) {
    const names = props.map(p => p.Name).slice(0, 10).join(', ');
    throw new Error(`No Buildium property matches "${locationName}". Buildium has: ${names}`);
  }
  const unitsRes = await fetch(`${BUILDIUM_BASE}/rentals/units?propertyids=${property.Id}&limit=200`, {
    headers: buildiumHeaders()
  });
  if (!unitsRes.ok) throw new Error(`Buildium units fetch failed: ${unitsRes.status}`);
  const units = await unitsRes.json();
  const targetUnit = unitNumber.trim().toLowerCase();
  const unit = units.find(u => (u.UnitNumber || '').trim().toLowerCase() === targetUnit);
  if (!unit) {
    const numbers = units.map(u => u.UnitNumber).slice(0, 20).join(', ');
    throw new Error(`No unit "${unitNumber}" in ${property.Name}. Available: ${numbers}`);
  }
  return { propertyId: property.Id, unitId: unit.Id, propertyName: property.Name };
}

function parseDate(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d)) return null;
  return d.toISOString().split('T')[0];
}
function addOneYear(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

export default requireAuth(async (req, res, session) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const { action, tenant } = body;
    if (action !== 'create') {
      res.status(400).json({ error: `Unsupported action: ${action}` });
      return;
    }
    if (!tenant?.email || !tenant?.location || !tenant?.suite || !tenant?.name) {
      res.status(400).json({ error: 'tenant.name, tenant.email, tenant.location, and tenant.suite are required' });
      return;
    }

    const { propertyId, unitId, propertyName } = await resolveIds(tenant.location, tenant.suite);
    const [first, ...rest] = tenant.name.split(' ');
    const last = rest.join(' ') || first;
    const moveIn = parseDate(tenant.date) || new Date().toISOString().split('T')[0];

    const payload = {
      PropertyId: propertyId,
      UnitId: unitId,
      LeaseType: 'Fixed',
      LeaseFromDate: moveIn,
      LeaseToDate: addOneYear(moveIn),
      Tenants: [{
        FirstName: first,
        LastName: last,
        Email: tenant.email,
        PhoneNumbers: tenant.phone ? [{ Number: tenant.phone, Type: 'Mobile' }] : [],
        SendWelcomeEmail: true
      }]
      // Rent charges intentionally omitted — they need a GL account ID specific to your
      // Buildium chart of accounts. Set rent inside Buildium after the lease is created.
    };

    const r = await fetch(`${BUILDIUM_BASE}/leases`, {
      method: 'POST',
      headers: buildiumHeaders(),
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      res.status(r.status).json({ error: err.UserMessage || err.Message || `Buildium returned ${r.status}`, detail: err });
      return;
    }
    const data = await r.json();
    res.status(200).json({ ok: true, leaseId: data.Id, propertyId, unitId, propertyName, createdBy: session.name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
