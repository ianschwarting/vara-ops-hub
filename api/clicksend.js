// POST /api/clicksend
// Body for add:    { action: 'add', listName, contact: {first, last, phone, email, suite, biz} }
// Body for remove: { action: 'remove', listName, phone }

import { requireAuth, readJsonBody } from '../lib/auth-middleware.js';

const CS_BASE = 'https://rest.clicksend.com/v3';

function authHeader() {
  const u = process.env.CLICKSEND_USERNAME;
  const k = process.env.CLICKSEND_API_KEY;
  if (!u || !k) throw new Error('ClickSend credentials not set on server');
  return 'Basic ' + Buffer.from(`${u}:${k}`).toString('base64');
}

async function getLists() {
  const r = await fetch(`${CS_BASE}/lists?limit=200`, { headers: { Authorization: authHeader() } });
  if (!r.ok) throw new Error(`ClickSend lists fetch failed: ${r.status}`);
  const data = await r.json();
  const items = data.data?.data || [];
  const byName = {};
  items.forEach(l => { byName[l.list_name.trim().toLowerCase()] = l.list_id; });
  return byName;
}

async function findListId(listName) {
  const lists = await getLists();
  const id = lists[listName.trim().toLowerCase()];
  if (!id) {
    const sample = Object.keys(lists).slice(0, 10).join(', ');
    throw new Error(`No ClickSend list named "${listName}". Available lists: ${sample}`);
  }
  return id;
}

async function findContactId(listId, phone) {
  const targetDigits = (phone || '').replace(/\D/g, '');
  if (!targetDigits) return null;
  let page = 1;
  while (page < 20) {
    const r = await fetch(`${CS_BASE}/lists/${listId}/contacts?page=${page}&limit=100`, {
      headers: { Authorization: authHeader() }
    });
    if (!r.ok) throw new Error(`Contact lookup failed: ${r.status}`);
    const data = await r.json();
    const contacts = data.data?.data || [];
    if (!contacts.length) return null;
    const match = contacts.find(c => (c.phone_number || '').replace(/\D/g, '').endsWith(targetDigits.slice(-10)));
    if (match) return match.contact_id;
    if (contacts.length < 100) return null;
    page++;
  }
  return null;
}

export default requireAuth(async (req, res, session) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const { action, listName } = body;
    if (!action || !listName) {
      res.status(400).json({ error: 'action and listName are required' });
      return;
    }
    const listId = await findListId(listName);

    if (action === 'add') {
      const c = body.contact || {};
      if (!c.phone) {
        res.status(400).json({ error: 'contact.phone is required' });
        return;
      }
      const r = await fetch(`${CS_BASE}/lists/${listId}/contacts`, {
        method: 'POST',
        headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone_number: c.phone,
          first_name: c.first || '',
          last_name: c.last || '',
          email: c.email || '',
          custom_1: c.suite || '',
          custom_2: c.biz || ''
        })
      });
      const data = await r.json();
      if (data.response_code !== 'SUCCESS') {
        res.status(400).json({ error: data.response_msg || 'ClickSend add failed', detail: data });
        return;
      }
      res.status(200).json({ ok: true, action: 'add', listId });
      return;
    }

    if (action === 'remove') {
      const phone = body.phone;
      if (!phone) {
        res.status(400).json({ error: 'phone is required for remove' });
        return;
      }
      const contactId = await findContactId(listId, phone);
      if (!contactId) {
        res.status(404).json({ error: `Phone ${phone} not found in list "${listName}". May already be removed.` });
        return;
      }
      const r = await fetch(`${CS_BASE}/lists/${listId}/contacts/${contactId}`, {
        method: 'DELETE',
        headers: { Authorization: authHeader() }
      });
      if (!r.ok) {
        res.status(r.status).json({ error: `Delete failed: ${r.status}` });
        return;
      }
      res.status(200).json({ ok: true, action: 'remove', listId, contactId });
      return;
    }

    res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});
