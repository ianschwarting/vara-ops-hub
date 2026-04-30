// POST /api/sheet-sync
// Body: { mode: 'on'|'off', tenant: {...} }
// Looks up the row matching (location, suite) and updates known columns.

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';
import { getServiceAccountToken } from '../lib/google-sa.js';

const TAB = 'Master Tenant Tracker';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

export default requireAuth(async (req, res, session) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) {
    res.status(500).json({ error: 'GOOGLE_SHEET_ID not set on server' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const { mode = 'on', tenant = {} } = body;
    if (!tenant.location || !tenant.suite) {
      res.status(400).json({ error: 'tenant.location and tenant.suite are required' });
      return;
    }

    const token = await getServiceAccountToken({
      scope: 'https://www.googleapis.com/auth/spreadsheets'
    });

    // Read columns A and C (location + suite) to find the right row
    const readRes = await fetch(
      `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(TAB)}!A:C`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!readRes.ok) {
      const err = await readRes.json().catch(() => ({}));
      res.status(readRes.status).json({ error: 'Could not read sheet', detail: err });
      return;
    }
    const readData = await readRes.json();
    const rows = readData.values || [];

    let rowIndex = -1;
    const targetLoc = tenant.location.trim().toLowerCase();
    const targetSuite = tenant.suite.trim().toLowerCase();
    for (let i = 1; i < rows.length; i++) {
      const locMatch = (rows[i][0] || '').trim().toLowerCase() === targetLoc;
      const suiteMatch = (rows[i][2] || '').trim().toLowerCase() === targetSuite;
      if (locMatch && suiteMatch) { rowIndex = i + 1; break; }
    }
    if (rowIndex === -1) {
      res.status(404).json({ error: `Could not find suite ${tenant.suite} at ${tenant.location} in the "${TAB}" tab.` });
      return;
    }

    // Column mapping (matches the existing hub):
    //   B=Person, E=Rent, K=Phone, L=Email, M=Business, N=Services, Q=DoorCode, R=Sink, W=MoveInDate
    const isOn = mode === 'on';
    const v = (key) => isOn ? (tenant[key] || '') : '';
    const updates = [
      { range: `${TAB}!B${rowIndex}`, values: [[v('name')]] },
      { range: `${TAB}!E${rowIndex}`, values: [[v('rent')]] },
      { range: `${TAB}!K${rowIndex}`, values: [[v('phone')]] },
      { range: `${TAB}!L${rowIndex}`, values: [[v('email')]] },
      { range: `${TAB}!M${rowIndex}`, values: [[v('biz')]] },
      { range: `${TAB}!N${rowIndex}`, values: [[v('services')]] },
      { range: `${TAB}!Q${rowIndex}`, values: [[v('doorcode')]] },
      { range: `${TAB}!R${rowIndex}`, values: [[v('sink')]] },
      { range: `${TAB}!W${rowIndex}`, values: [[v('date')]] }
    ];

    const writeRes = await fetch(`${SHEETS_BASE}/${sheetId}/values:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates })
    });
    if (!writeRes.ok) {
      const err = await writeRes.json().catch(() => ({}));
      res.status(writeRes.status).json({ error: 'Could not write to sheet', detail: err });
      return;
    }

    res.status(200).json({ ok: true, rowUpdated: rowIndex, updatedBy: session.name });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
