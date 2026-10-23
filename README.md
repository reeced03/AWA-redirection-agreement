# AWA Insurance – Benefits Redirection Agreement

Employees scan a QR code, verify with the **last 4 of their SSN + date of birth**, review a prefilled agreement, make their selection, and sign on their phone. AWA gets a signed PDF by email and downloads the **Open Enrollment Redirection** spreadsheet from the admin page.

Every company gets its own agreement form (wording, plans, coverage levels, waiver reasons), its own QR code and its own spreadsheets. What stays the same for every company:

| | Field | Source / destination |
|---|---|---|
| 🟨 Yellow | Employee name, current home address, current enrollment for each coverage level | Prefilled from the company's **Current Redirection** sheet |
| 🟦 Blue | Home address correction, paycheck-redirection selection **or** waiver reasons, signature + date | Written to the **Open Enrollment Redirection** sheet (and the signed PDF) |

## How it works

1. **Admin** (`/admin`) → *Add a company* → edit the agreement form (starts from the AWA standard form, or copy another company's) → *Preview form*.
2. **Upload** that company's *Current Redirection* `.xlsx`. Required columns: `Name`, `Date of Birth`, `SS#`, `Current Address`, plus one column per coverage level (e.g. `FB 1 EE` … `FB 2 FM`). Each coverage level on the form names the spreadsheet column it reads from and writes to.
3. **QR code** → print the sign or download the image. It links to `https://<your-site>/e/<company-link-name>`.
4. **Employee** scans → verifies → sees yellow fields filled in → picks a coverage level (or declines and checks reasons) → signs with finger/mouse → date fills in automatically → submits. Nothing is saved in the browser; leaving or refreshing means starting over. Sessions expire after 30 minutes. Each employee can submit once (admin can *Reset* to allow a redo).
5. **AWA** receives the signed PDF by email and downloads the *Open Enrollment Redirection* sheet: same columns as your template (`Name`, `Date of Birth`, `SS#`, `Correction Address`, `FB 1 EE` …), an **X** under the selected coverage level, plus `Status`, `Waiver Reasons` and `Signed Date` columns at the end. Every employee on the roster is listed, so you can see who hasn't signed yet.

## Deploy to Netlify

1. Netlify → **Add new site → Import an existing project** → GitHub → this repo. Build settings come from `netlify.toml` (publish `public`, functions `netlify/functions`, no build command needed).
2. **Site configuration → Environment variables**, add:

| Variable | Required | Value |
|---|---|---|
| `APP_SECRET` | ✅ | Long random string, 32+ characters. Encrypts stored data and signs sessions. **Never change it after go-live**, or stored data can't be read. Generate one: `openssl rand -base64 48` |
| `ADMIN_PASSWORD` | ✅ | Password for `/admin` (10+ characters) |
| `NOTIFY_EMAIL` | | Default address for signed PDFs (each company can override) |
| `SMTP_HOST` | for email | e.g. `smtp.office365.com` (Microsoft 365) or `smtp.gmail.com` |
| `SMTP_PORT` | | `587` (default) or `465` |
| `SMTP_USER` / `SMTP_PASS` | for email | Mailbox login (for Microsoft 365/Google, an app password or SMTP-enabled account) |
| `MAIL_FROM` | for email | e.g. `AWA Insurance <benefits@awainsurance.com>` |
| `SESSION_MINUTES` | | Employee session length, default `30` |

3. Deploy, then open `https://<your-site>/admin`.

Without SMTP settings everything still works; signed PDFs are just downloaded from the admin page instead of emailed.

**Logo:** the header uses the logo from awainsurance.com. To use your own file instead, add `public/logo.png`.

## Security

- SSN and date of birth are checked on the server only. The browser receives just the yellow fields — never the SSN or full roster.
- Rosters, submissions and PDFs are encrypted (AES-256-GCM) before they're stored in Netlify Blobs.
- Verification is rate-limited (8 failed tries per 15 minutes per device), as is admin sign-in.
- If two employees on a roster share the same SSN last 4 + date of birth, neither can verify online; the upload report flags them so AWA can handle them directly.
- Signed PDFs include an e-signature record (time, IP, confirmation number, consent).

## Local development

```bash
npm install
npm run dev                                   # http://localhost:8888  (admin password: local-admin-pass)
node scripts/smoke-test.mjs "Current Redirection.xlsx"   # end-to-end API test
```

Local data is kept in `.local-data/` (git-ignored).

## Project layout

```
public/            Static pages: form.html (employee), admin.html, styles, js/
netlify/functions/ api.mjs – every /api/* route
lib/               template (per-company forms), roster (xlsx import/export), pdf, mail, storage, crypto
scripts/           dev server and smoke test
```
