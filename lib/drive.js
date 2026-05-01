// Google Drive helpers — uploads PDFs and locates tenant folders.
//
// Folder layout (assumed):
//   /VARA Tenants/{Location}/{Suite - Tenant Name}/
//
// We resolve folders by name. The DRIVE_ROOT_FOLDER_ID env var tells us where
// to start looking. Service account needs Editor access to that folder tree.

import { getServiceAccountToken } from './google-sa.js';

const DRIVE_BASE = 'https://www.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/drive';

async function driveToken() {
  return getServiceAccountToken({ scope: SCOPE });
}

async function driveFetch(path, options = {}) {
  const token = await driveToken();
  const r = await fetch(`${DRIVE_BASE}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Drive ${path}: ${r.status} ${text}`);
  }
  return r;
}

// Search for a folder by name within a parent. Returns the file id or null.
export async function findFolderByName(parentId, name) {
  const q = encodeURIComponent(
    `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`
  );
  const r = await driveFetch(`/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=10`);
  const data = await r.json();
  const folder = (data.files || [])[0];
  return folder ? folder.id : null;
}

export async function createFolder(parentId, name) {
  const r = await driveFetch('/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  const data = await r.json();
  return data.id;
}

export async function findOrCreateFolder(parentId, name) {
  const existing = await findFolderByName(parentId, name);
  if (existing) return existing;
  return createFolder(parentId, name);
}

// Resolve (or create) the tenant's folder following: root/Location/Suite — Name
export async function resolveTenantFolder(tenant) {
  const root = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!root) throw new Error('DRIVE_ROOT_FOLDER_ID not set on server');
  const locationFolder = await findOrCreateFolder(root, tenant.location);
  const tenantFolderName = `${tenant.suite} - ${tenant.name}`;
  return findOrCreateFolder(locationFolder, tenantFolderName);
}

// Upload a file (Buffer) to a Drive folder. Returns the new file id.
export async function uploadFile({ folderId, filename, contentType, body }) {
  // Multipart upload: metadata + file content in one request.
  const boundary = '----vara-' + Math.random().toString(36).slice(2);
  const metadata = {
    name: filename,
    parents: [folderId]
  };
  const bodyParts = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${contentType}`,
    '',
    ''
  ];
  const head = Buffer.from(bodyParts.join('\r\n'), 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const fullBody = Buffer.concat([head, body, tail]);

  const r = await driveFetch('/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: fullBody
  });
  return r.json();
}
