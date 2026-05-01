# VARA Ops Hub — Deployment Guide

This is a step-by-step for moving from the current static HTML deploy to the
new auth-protected version with server-side API keys and a shared password.

## What's changing

**Before:** PMs paste API keys into Settings on each browser. Service account
private key sits in publicly-viewable HTML. Client-side calls to Anthropic,
Buildium, ClickSend, Gmail, Sheets.

**After:** PMs sign in with a shared hub password. Zero credentials
client-side. All third-party calls proxied through Vercel serverless functions.

## What this is NOT

This is **shared-password auth**, not real per-user authentication. Everyone
who has the password can sign in. The "Your name" field is cosmetic — anyone
can type any name. Do not rely on it for security.

When you're ready, swap to Google domain-restricted sign-in (described at the
bottom of this doc) for proper per-user auth. The migration is small.

## Prerequisites

You need:
- Access to the existing Vercel project (`vara-ops-hub`)
- The existing service account private key (currently hardcoded in the OLD
  `vara-ops-hub.html` — search for `SA_KEY`. We'll move it to env vars.)
- Workspace admin access at admin.google.com (only needed for Gmail send to
  work — domain-wide delegation step)

## Step 1 — Set Vercel environment variables

Go to your Vercel project → Settings → Environment Variables. Add each of
these (set Environment to "Production" and "Preview"):

| Name | Value |
|------|-------|
| `HUB_PASSWORD` | The shared password PMs will use. Pick something memorable but not guessable. |
| `SESSION_SECRET` | Random 32+ char string. Generate one with `openssl rand -hex 32` (or any random string generator). |
| `ANTHROPIC_API_KEY` | The key Ian created (or a new one) |
| `BUILDIUM_CLIENT_ID` | From Buildium → Settings → API |
| `BUILDIUM_CLIENT_SECRET` | Same place |
| `CLICKSEND_USERNAME` | Your ClickSend login email |
| `CLICKSEND_API_KEY` | From ClickSend → Developers → API Credentials |
| `GOOGLE_SA_EMAIL` | `vara-ops-service@vara-ops.iam.gserviceaccount.com` |
| `GOOGLE_SA_PRIVATE_KEY` | The full PEM key, starting with `-----BEGIN PRIVATE KEY-----`. **Important:** in Vercel UI, paste with real newlines (not `\n` escape sequences). The current key is in the OLD `vara-ops-hub.html` (search for `SA_KEY`). |
| `SUPPORT_EMAIL` | The email address welcome/goodbye mails are sent from (e.g. `support@varasuites.com`) |
| `GOOGLE_SHEET_ID` | `1NQ1ndqIfUf3yfRtLjY4r8XtbzPVbHclkUSUc_JPSDwU` (the Master Tenant Tracker sheet) |

## Step 2 — Domain-wide delegation for the service account (only needed for Gmail send)

If you've never set this up before, do it now. Without it, **the "Send email"
button will fail** with "unauthorized_client". Sheet sync still works without it.

1. Go to <https://admin.google.com> → Security → Access and data control → API controls
2. Click **Manage Domain Wide Delegation**
3. Click **Add new**
4. Client ID: the **numeric** Client ID of the service account. Find it by asking
   Ian to look at console.cloud.google.com → IAM & Admin → Service Accounts → click
   `vara-ops-service` → Advanced settings → Client ID. (You don't need access to
   the Google Cloud project to do *this* step in admin.google.com — but Ian
   needs to send you the numeric Client ID.)
5. OAuth scopes (paste comma-separated):
   ```
   https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/gmail.send
   ```
6. Authorize

If you can't get the numeric Client ID right now, you can skip this step and
just not use the email send feature yet. Everything else will still work.

## Step 3 — Deploy the new code

The repo structure is:

```
public/vara-ops-hub.html    ← rewritten frontend
api/                         ← Vercel serverless functions
lib/                         ← shared helpers
package.json
vercel.json
```

Replace the existing repo contents with this folder. Push to main / your
deploy branch. Vercel will auto-build.

The build should "just work" — Vercel detects `package.json`, installs deps,
treats `api/*.js` as serverless functions, serves `public/` as static files.

## Step 4 — Smoke tests, in order

If any of these fail, fix that one before moving on. The errors get progressively
harder to debug, so go in order.

### 4a. Site loads
Visit <https://vara-ops-hub.vercel.app>. You should see the login screen with
"Your name" and "Password" fields.

### 4b. Login works
Type your name and the `HUB_PASSWORD` you set. Click Sign in. You should land
on the dashboard with your name in the top-right.

If you get "Server misconfigured: HUB_PASSWORD not set", you forgot to set the
env var in Vercel, or you didn't redeploy after setting it.

If you get "Incorrect password" with the right password, the env var probably
has trailing whitespace. Re-enter it carefully.

### 4c. Wrong password is rejected
Sign out (top-right). Try logging in with a wrong password. Should get
"Incorrect password". After 10 wrong tries from the same IP within 5 minutes,
you should get "Too many failed attempts."

### 4d. Session persists
Refresh the page. You should stay signed in (no re-login required). Sessions
last 30 days unless you sign out.

### 4e. AI generation works
Onboard a fake tenant: any location, suite "TEST-001", name "Smoke Test",
fake email/phone. Click Generate. You should see the welcome email and PM
notes appear within ~5 seconds.

If you see "ANTHROPIC_API_KEY not set", that env var is missing.

### 4f. ClickSend list lookup
With the same fake tenant, click "Add to list". If it succeeds, the location
list exists in ClickSend. If you get "No ClickSend list named "X"", create one
in ClickSend with the exact location name as the list name.

### 4g. Buildium lookup
Click "Create in Buildium". With suite "TEST-001" it will fail because no real
Buildium unit has that number — that's expected. The error message should list
the available unit numbers, which proves the API auth works.

**Don't run this test with a real suite number unless you want a real Buildium
tenant created.**

### 4h. Sheet sync
Go to a real suite that exists in your sheet. Don't bother filling out
extensive details. Click "Mark complete & log". Watch the green confirmation
toast. Open the sheet, verify the row updated.

### 4i. Email send (skip if you skipped Step 2)
Test with your own email as the tenant email. Click "Send email" on a
generated welcome email. Check your inbox. If you get an "unauthorized_client"
error, the domain-wide delegation isn't configured correctly (Step 2).

## Step 5 — Onboard the PMs

Once 4a–4h pass, send each PM:

> Hub URL: <https://vara-ops-hub.vercel.app>
> Password: [whatever you set HUB_PASSWORD to]
> Open the URL, type your name and the password, sign in. That's it.

Don't post the password in Slack/email — share it via 1Password, an in-person
conversation, or a self-destructing note service.

## Rotating the password

If a PM leaves or you want to rotate:
1. Update `HUB_PASSWORD` in Vercel env vars
2. Redeploy (just a no-op redeploy is fine)
3. **Important:** also update `SESSION_SECRET` to invalidate all current
   sessions. Otherwise existing sessions stay valid for up to 30 days even
   after the password changes.
4. Tell remaining PMs the new password

## Rotating API credentials

Any of the third-party API keys can be rotated by updating the env var in
Vercel and redeploying. No PM action needed. This is the main reason we did
this migration.

## Future: Migrating to Google domain-restricted sign-in

When you want real per-user auth (recommended once Ian adds you to the Google
Cloud project):

1. Create a Google OAuth Client ID in console.cloud.google.com → APIs &
   Services → Credentials → Create OAuth client ID. Application type: Web.
   Authorized JS origin: `https://vara-ops-hub.vercel.app`.
2. Add env vars: `GOOGLE_OAUTH_CLIENT_ID`, `ALLOWED_EMAIL_DOMAIN=varasuites.com`
3. Replace `api/auth/login.js` with the Google version (I can provide this
   when you're ready — it's the same as what was in the previous draft of
   this hub)
4. Update the login screen UI to show the Google button instead of the
   password form

The session cookie format is identical between the two auth methods, so
nothing else changes. Existing sessions will expire naturally as PMs sign in
with Google.

## Cost

Vercel hobby tier is free for this volume. Anthropic billing stays the same.
Google service account is free. Estimated monthly cost: $0 incremental beyond
the API costs you're already paying.
