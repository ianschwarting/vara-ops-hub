// Tenant pipeline records — stored in Vercel KV.
//
// Key layout:
//   tenant:{id}                → JSON tenant record
//   intake-token:{token}       → tenant id (lookup table for intake form links)
//   pandadoc:{document_id}     → tenant id (lookup table for PandaDoc webhooks)
//   tenants:index              → array of all tenant ids (for listing/pipeline view)
//
// We use the Vercel KV REST API directly (no @vercel/kv SDK) to keep dependency
// count at zero. The connection details are auto-injected by Vercel into env vars
// when you create a KV store: KV_REST_API_URL and KV_REST_API_TOKEN.

import crypto from 'node:crypto';

const KV_URL = () => process.env.KV_REST_API_URL;
const KV_TOKEN = () => process.env.KV_REST_API_TOKEN;

function assertKvConfigured() {
  if (!KV_URL() || !KV_TOKEN()) {
    throw new Error('Vercel KV not configured. Create a KV store in Vercel → Storage and connect it to this project.');
  }
}

// ─── Low-level KV operations ────────────────────────────────────────────────

async function kvFetch(command) {
  // Upstash-compatible REST API. command is an array like ['GET', 'foo'] or ['SET', 'foo', '"bar"'].
  assertKvConfigured();
  const r = await fetch(KV_URL(), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KV_TOKEN()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(command)
  });
  if (!r.ok) throw new Error(`KV ${command[0]} failed: ${r.status} ${await r.text().catch(() => '')}`);
  const data = await r.json();
  return data.result;
}

async function kvGet(key) {
  const result = await kvFetch(['GET', key]);
  if (result == null) return null;
  try { return JSON.parse(result); } catch { return result; }
}

async function kvSet(key, value) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  await kvFetch(['SET', key, serialized]);
}

async function kvDel(key) {
  await kvFetch(['DEL', key]);
}

// ─── ID + token generation ──────────────────────────────────────────────────

function newTenantId() {
  // Short, sortable, unique. yyMMdd + random suffix.
  const now = new Date();
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(4).toString('hex');
  return `t${ymd}-${suffix}`;
}

function newIntakeToken() {
  // 32 chars of url-safe random. Used in the intake form URL.
  return crypto.randomBytes(24).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// ─── Tenant record shape ────────────────────────────────────────────────────

// Stages a tenant moves through. Order matters — use stageRank() to compare.
export const STAGES = [
  'draft',           // PM created the record, hasn't sent lease yet
  'lease_sent',      // PandaDoc lease sent to tenant
  'lease_signed',    // Tenant signed; lease saved to Drive; welcome email queued
  'form_pending',    // Welcome email sent; awaiting move-in form submission
  'form_submitted',  // Form submitted; awaiting PM review
  'processed',       // PM clicked Process; downstream automations fired
  'archived'         // Move-out or cancelled
];

export function stageRank(stage) {
  const i = STAGES.indexOf(stage);
  return i === -1 ? 999 : i;
}

export function newTenant({ name, email, phone, location, suite, leaseStartDate, weeklyRent, createdBy }) {
  const now = new Date().toISOString();
  return {
    id: newTenantId(),
    stage: 'draft',
    // Fields the PM enters at creation time
    name: name || '',
    email: email || '',
    phone: phone || '',
    location: location || '',
    suite: suite || '',
    leaseStartDate: leaseStartDate || '',
    weeklyRent: weeklyRent || '',
    // Fields populated later (form submission)
    intakeToken: newIntakeToken(),
    intakeResponse: null,        // filled at form submission
    intakeFiles: [],             // [{ kind: 'license'|'deposit', blobUrl, filename, contentType }]
    // PandaDoc tracking
    pandadocDocumentId: null,
    pandadocSentAt: null,
    pandadocSignedAt: null,
    leaseDriveFileId: null,
    // Email tracking
    welcomeEmailSentAt: null,
    // Audit
    createdAt: now,
    createdBy: createdBy || 'unknown',
    updatedAt: now,
    history: [{ stage: 'draft', at: now, by: createdBy || 'unknown' }]
  };
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function saveTenant(tenant) {
  tenant.updatedAt = new Date().toISOString();
  await kvSet(`tenant:${tenant.id}`, tenant);
  // Maintain lookup tables
  if (tenant.intakeToken) {
    await kvSet(`intake-token:${tenant.intakeToken}`, tenant.id);
  }
  if (tenant.pandadocDocumentId) {
    await kvSet(`pandadoc:${tenant.pandadocDocumentId}`, tenant.id);
  }
  // Maintain index
  const index = (await kvGet('tenants:index')) || [];
  if (!index.includes(tenant.id)) {
    index.push(tenant.id);
    await kvSet('tenants:index', index);
  }
  return tenant;
}

export async function getTenant(id) {
  return kvGet(`tenant:${id}`);
}

export async function getTenantByIntakeToken(token) {
  const id = await kvGet(`intake-token:${token}`);
  return id ? getTenant(id) : null;
}

export async function getTenantByPandadocId(documentId) {
  const id = await kvGet(`pandadoc:${documentId}`);
  return id ? getTenant(id) : null;
}

export async function listTenants() {
  const index = (await kvGet('tenants:index')) || [];
  if (!index.length) return [];
  // Fetch all in parallel. For up to ~500 tenants this is fine; beyond that we'd batch.
  const tenants = await Promise.all(index.map(id => getTenant(id)));
  return tenants.filter(Boolean);
}

export async function transitionStage(tenant, newStage, by) {
  const now = new Date().toISOString();
  tenant.stage = newStage;
  tenant.updatedAt = now;
  tenant.history = tenant.history || [];
  tenant.history.push({ stage: newStage, at: now, by: by || 'system' });
  return saveTenant(tenant);
}
