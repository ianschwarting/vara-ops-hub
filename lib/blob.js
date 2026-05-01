// Vercel Blob storage helpers.
// Docs: https://vercel.com/docs/vercel-blob/using-blob-sdk
//
// We use the REST API directly via the BLOB_READ_WRITE_TOKEN env var
// (auto-injected by Vercel when you create a Blob store).
//
// Files are scoped under intake/{tenantId}/{kind}-{timestamp}-{filename} to
// keep them organized and avoid collisions.

function getToken() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error('BLOB_READ_WRITE_TOKEN not set — create a Blob store in Vercel → Storage');
  return t;
}

// Upload a file to Vercel Blob. body is a Buffer.
// Returns { url, downloadUrl, pathname }.
export async function uploadBlob({ pathname, contentType, body }) {
  const r = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-content-type': contentType || 'application/octet-stream',
      'x-add-random-suffix': '0'  // we generate our own paths
    },
    body
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Blob upload failed: ${r.status} ${text}`);
  }
  return r.json();
}

// Download a blob's content as a Buffer.
export async function downloadBlob(url) {
  const r = await fetch(url, {
    headers: { 'Authorization': `Bearer ${getToken()}` }
  });
  if (!r.ok) throw new Error(`Blob download failed: ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
