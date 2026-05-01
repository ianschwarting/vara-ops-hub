// POST /api/intake-submit
// PUBLIC endpoint (auth via the intake token, not session).
//
// Content-Type: multipart/form-data
// Form fields:
//   token              — required, validates the tenant
//   heardAbout         — required
//   businessName       — required
//   services           — required
//   sinkType           — required (Hair Sink | Pedestal/Vanity | No Sink)
//   doorCode           — optional 4-digit
//   instagram          — required
//   guideAcknowledged  — required ("on" / "true")
//   licensePhoto       — file, required
//   depositPhoto       — file, required
//
// Plus optional updates if the tenant noticed something wrong:
//   name, email, phone — can be edited (but not location/suite)

import { getTenantByIntakeToken, transitionStage, saveTenant } from '../lib/tenants.js';
import { uploadBlob } from '../lib/blob.js';

export const config = {
  api: {
    bodyParser: false,
    sizeLimit: '25mb'  // 2 files at 10mb max + form fields
  }
};

// Minimal multipart parser — we only need it for this one endpoint and want to
// avoid pulling in formidable/busboy as deps.
async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) throw new Error('Missing multipart boundary');
  const boundary = boundaryMatch[1].replace(/^"|"$/g, '');

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buffer = Buffer.concat(chunks);

  const fields = {};
  const files = {};

  const boundaryBytes = Buffer.from(`--${boundary}`);
  const parts = splitBuffer(buffer, boundaryBytes).slice(1, -1);  // drop preamble + closing

  for (const part of parts) {
    // Each part has headers, blank line, then content. Strip leading \r\n if present.
    let content = part;
    if (content[0] === 0x0d && content[1] === 0x0a) content = content.slice(2);
    // Trailing \r\n before next boundary
    if (content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.slice(0, -2);
    }

    const headerEnd = content.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;
    const headerStr = content.slice(0, headerEnd).toString('utf8');
    const body = content.slice(headerEnd + 4);

    // Parse Content-Disposition
    const dispMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!dispMatch) continue;
    const name = dispMatch[1];
    const filename = dispMatch[2];

    if (filename) {
      const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      files[name] = {
        filename,
        contentType: (ctMatch ? ctMatch[1] : 'application/octet-stream').trim(),
        data: body
      };
    } else {
      fields[name] = body.toString('utf8');
    }
  }

  return { fields, files };
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let idx;
  while ((idx = buffer.indexOf(separator, start)) !== -1) {
    parts.push(buffer.slice(start, idx));
    start = idx + separator.length;
  }
  parts.push(buffer.slice(start));
  return parts;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_FILE_TYPES = new Set(['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { fields, files } = await parseMultipart(req);

    if (!fields.token) {
      res.status(400).json({ error: 'token required' });
      return;
    }
    const tenant = await getTenantByIntakeToken(fields.token);
    if (!tenant) {
      res.status(404).json({ error: 'Invalid or expired link.' });
      return;
    }
    if (tenant.stage === 'form_submitted' || tenant.stage === 'processed' || tenant.stage === 'archived') {
      res.status(409).json({ error: 'This form has already been submitted.' });
      return;
    }

    // Required fields
    const required = ['heardAbout', 'businessName', 'services', 'sinkType', 'instagram'];
    for (const f of required) {
      if (!fields[f] || !fields[f].trim()) {
        res.status(400).json({ error: `Missing required field: ${f}` });
        return;
      }
    }
    if (!fields.guideAcknowledged || !['on', 'true', '1', 'yes'].includes(fields.guideAcknowledged.toLowerCase())) {
      res.status(400).json({ error: 'You must acknowledge reading the Tenant Info Guide.' });
      return;
    }

    // Required files
    if (!files.licensePhoto) {
      res.status(400).json({ error: "Driver's license photo is required." });
      return;
    }
    if (!files.depositPhoto) {
      res.status(400).json({ error: 'Proof of deposit is required.' });
      return;
    }

    // Validate file size + type
    for (const [key, file] of Object.entries(files)) {
      if (file.data.length > MAX_FILE_SIZE) {
        res.status(400).json({ error: `${key} is over 10 MB.` });
        return;
      }
      if (!ALLOWED_FILE_TYPES.has(file.contentType)) {
        res.status(400).json({ error: `${key} must be an image or PDF (got ${file.contentType}).` });
        return;
      }
    }

    // Allow tenant to edit a few fields if they spot a mistake
    if (fields.name && fields.name.trim()) tenant.name = fields.name.trim();
    if (fields.email && fields.email.trim()) tenant.email = fields.email.trim();
    if (fields.phone && fields.phone.trim()) tenant.phone = fields.phone.trim();

    // Upload files to blob
    const uploadFile = async (kind, file) => {
      const ts = Date.now();
      const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const pathname = `intake/${tenant.id}/${kind}-${ts}-${safeName}`;
      const result = await uploadBlob({
        pathname,
        contentType: file.contentType,
        body: file.data
      });
      return {
        kind,
        blobUrl: result.url,
        downloadUrl: result.downloadUrl || result.url,
        filename: file.filename,
        contentType: file.contentType,
        size: file.data.length
      };
    };

    const licenseFile = await uploadFile('license', files.licensePhoto);
    const depositFile = await uploadFile('deposit', files.depositPhoto);

    // Persist intake response
    tenant.intakeResponse = {
      heardAbout: fields.heardAbout.trim(),
      businessName: fields.businessName.trim(),
      services: fields.services.trim(),
      sinkType: fields.sinkType.trim(),
      doorCode: (fields.doorCode || '').trim(),
      instagram: fields.instagram.trim(),
      guideAcknowledged: true,
      submittedAt: new Date().toISOString()
    };
    tenant.intakeFiles = [licenseFile, depositFile];

    await saveTenant(tenant);
    await transitionStage(tenant, 'form_submitted', 'tenant');

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
