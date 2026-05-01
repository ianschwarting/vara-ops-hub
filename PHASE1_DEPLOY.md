# VARA Ops Hub — Phase 1 Deployment

This adds the new tenant pipeline workflow on top of what's already deployed.
The existing "Quick draft" tab still works as before. Nothing existing breaks.

## What's new

- **Pipeline tab** — list of all tenants in progress, with a "+ New tenant" button
- **PandaDoc lease send** — generate + email a lease from your template
- **Lease signed webhook** — when the tenant signs, the PDF auto-saves to Google Drive
- **Welcome email** — sends a unique intake link to the tenant
- **Native intake form** at `/intake/{token}` — pre-filled, mobile-friendly
- **File uploads** (driver's license + deposit) stored in Vercel Blob

## Setup steps (in order)

### 1. Vercel KV (database for tenant records)

In Vercel → your project → Storage tab → Create Database:
- Pick **KV**
- Name: `vara-ops-kv` (or whatever)
- Region: nearest to your users
- Click Create
- When asked, connect it to your `vara-ops-hub` project — this auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` env vars

### 2. Vercel Blob (file storage for license + deposit photos)

Same Storage tab → Create Database:
- Pick **Blob**
- Name: `vara-ops-blob`
- Connect to your project — auto-injects `BLOB_READ_WRITE_TOKEN`

### 3. Google Drive root folder

In Google Drive, create (or pick) a folder where tenant subfolders should live, e.g. "VARA Tenants". The hub will create per-location and per-tenant subfolders inside.

- Right-click the folder → Share → add `vara-ops-service@vara-ops.iam.gserviceaccount.com` as **Editor** (Viewer is not enough — we need to upload files)
- Open the folder, copy the ID from the URL: `drive.google.com/drive/folders/[THIS_PART]`
- Add to Vercel env vars: `DRIVE_ROOT_FOLDER_ID`

### 4. Service account scope upgrade

The Google service account needs Drive write access. In admin.google.com → Security → API controls → Manage Domain Wide Delegation:

Find the existing entry for the `vara-ops-service` numeric Client ID and **edit** the scopes. Update to (note the new third scope):

```
https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/drive
```

### 5. PandaDoc account + API key

- Sign up at [pandadoc.com](https://pandadoc.com) — Starter plan is free for low volume
- Settings → Integrations → API → Create API Key
- Add to Vercel env vars: `PANDADOC_API_KEY`

### 6. PandaDoc lease template

This is the only manual content step. In PandaDoc:

- Templates → New Template → upload your existing lease PDF or build from scratch
- Add **Recipient role**: name it exactly `Tenant`
- Add **merge field tokens** (Insert → Variables) with these exact names:
  - `tenant_name`
  - `tenant_email`
  - `tenant_phone`
  - `location`
  - `suite`
  - `lease_start_date`
  - `weekly_rent`
- Add a **signature field** assigned to the Tenant role
- Save the template
- Copy the template UUID from its URL (`pandadoc.com/a/templates/[THIS_PART]/edit`)
- Add to Vercel env vars: `PANDADOC_LEASE_TEMPLATE_ID`

### 7. PandaDoc webhook

In PandaDoc → Workspace settings → Webhooks → Add webhook:

- URL: `https://vara-ops-hub.vercel.app/api/pandadoc-webhook`
- Events: check `document_state_changed`
- Generate a "shared key" (any random 32+ char string — pandadoc may give you one)
- Save the shared key
- Add to Vercel env vars: `PANDADOC_WEBHOOK_KEY`

### 8. Deploy

Push the Phase 1 code to GitHub. Vercel auto-deploys.

## Smoke tests

### A. Pipeline view loads
Sign into the hub, click Pipeline tab. You should see "No tenants in the pipeline yet" with a button to create one.

If you see "Could not load pipeline: ..." — check that `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set (they should be auto-injected when you connected KV in step 1).

### B. Create a tenant
Click "+ New tenant". Fill in the form with test data including your own email. Click Create.

You should land on the tenant detail view with a "Send lease for signature" button. The tenant appears in the pipeline list.

### C. Send a lease (real test, but to yourself)
**Use your own email as the tenant email** for this test so the lease lands in your inbox.

Click "Send lease for signature". This takes 10-20 seconds (PandaDoc has to process the document). You should see the stage change to "Lease sent" and an email arrive at your inbox.

If you get an error mentioning template fields, your PandaDoc template is missing one of the merge tokens or the recipient role isn't named exactly "Tenant".

### D. Sign the lease
In the email, click through to PandaDoc and sign the document. Within ~30 seconds, the webhook should fire and the tenant's stage should advance to "Lease signed". Refresh the Pipeline tab and you'll see the change.

Check Google Drive: under your `DRIVE_ROOT_FOLDER_ID` folder, you should see a new subfolder for the location, then another for the tenant, with the signed PDF inside.

If the webhook doesn't fire: in PandaDoc → Webhooks → click your webhook → Recent deliveries. If you see retries failing, the signature secret is probably wrong.

### E. Send welcome email
With the tenant in "Lease signed" state, click "Send welcome email + intake link". You should get a welcome email at your test address with a link like `vara-ops-hub.vercel.app/intake/abc...`.

### F. Fill out the intake form
Click the link in the email. You should see the move-in form, pre-filled with the tenant's name/email/phone/location/suite. Fill it out (use any small image files for the license and deposit uploads).

Submit. The page should show "Form already submitted ✓".

Back in the hub, the tenant's stage should be "Form submitted". You can expand the form responses in the tenant detail view.

## Phase 1 ends here

Phase 2 will add:
- The "Process" button that fires Buildium / ClickSend / Sheet sync / Drive upload of intake files in one shot
- A review screen with edit-before-process capability
- Move-out flow integration
