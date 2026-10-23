// Single API function for the app. Netlify routes every /api/* request here.
import { getConfig, assertConfigured } from '../../lib/config.mjs';
import { signToken, verifyToken, hashForKey, safeEqualString, randomId } from '../../lib/crypto.mjs';
import { openStore, keys } from '../../lib/storage.mjs';
import { cleanTemplate, defaultTemplate, publicTemplate, allTiers } from '../../lib/template.mjs';
import { parseRoster, buildExport } from '../../lib/roster.mjs';
import { renderAgreementPdf } from '../../lib/pdf.mjs';
import { emailSignedAgreement } from '../../lib/mail.mjs';

export const config = { path: '/api/*' };

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const baseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, 'content-type': 'application/json; charset=utf-8' } });
const file = (bytes, type, filename) => new Response(bytes, {
  status: 200,
  headers: { ...baseHeaders, 'content-type': type, 'content-disposition': `attachment; filename="${filename.replace(/[^\w .()-]/g, '_')}"` },
});

async function readJson(req, max = 1_000_000) {
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'Request is too large.');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Invalid request.'); }
}

function clientIp(req, context) {
  return context?.ip || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}

// ---------- rate limiting ----------
async function checkLimit(store, scope, id, limit) {
  const key = keys.rateLimit(scope, id);
  const rec = await store.getJSON(key);
  if (rec && rec.resetAt > Date.now() && rec.count >= limit) {
    const mins = Math.ceil((rec.resetAt - Date.now()) / 60000);
    throw new HttpError(429, `Too many attempts. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`);
  }
}
async function recordFailure(store, scope, id, windowMs) {
  const key = keys.rateLimit(scope, id);
  const rec = await store.getJSON(key);
  const fresh = !rec || rec.resetAt <= Date.now();
  await store.setJSON(key, fresh ? { count: 1, resetAt: Date.now() + windowMs } : { count: rec.count + 1, resetAt: rec.resetAt });
}
async function clearLimit(store, scope, id) { await store.delete(keys.rateLimit(scope, id)); }

// ---------- helpers ----------
async function loadCompany(store, slug) {
  if (!/^[a-z0-9-]{1,40}$/.test(slug || '')) return null;
  return store.getJSON(keys.company(slug));
}

async function loadSubmissions(store, slug) {
  const list = await store.list(keys.submissionsPrefix(slug));
  const subs = await Promise.all(list.map((k) => store.getSecretJSON(k)));
  return subs.filter(Boolean);
}

function requireAdmin(req, cfg) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!verifyToken(cfg.appSecret, token, 'adm')) throw new HttpError(401, 'Please sign in again.');
}

function confirmationCode() {
  return randomId(4).toUpperCase().replace(/(.{4})(.{4})/, '$1-$2');
}

function isPng(bytes) {
  return bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

// ---------- public routes ----------
async function getCompanyPublic(store, slug) {
  const company = await loadCompany(store, slug);
  if (!company || !company.active) throw new HttpError(404, 'This enrollment link is not active. Please contact AWA Insurance.');
  return json(200, { template: publicTemplate(company) });
}

async function verifyEmployee(req, context, store, cfg) {
  const body = await readJson(req, 10_000);
  const slug = String(body.slug || '');
  const last4 = String(body.last4 || '').trim();
  const dob = String(body.dob || '').trim();
  if (!/^\d{4}$/.test(last4)) throw new HttpError(400, 'Enter the last 4 digits of your Social Security Number.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError(400, 'Enter your date of birth.');

  const company = await loadCompany(store, slug);
  if (!company || !company.active) throw new HttpError(404, 'This enrollment link is not active. Please contact AWA Insurance.');
  const ipKey = hashForKey(cfg.appSecret, `${slug}|${clientIp(req, context)}`);
  await checkLimit(store, 'verify', ipKey, 8);

  const roster = await store.getSecretJSON(keys.roster(slug));
  if (!roster?.employees?.length) throw new HttpError(503, 'Enrollment is not open yet. Please contact AWA Insurance.');

  const matches = roster.employees.filter((e) => e.dob === dob && e.ssn.slice(-4) === last4);
  if (!matches.length) {
    await recordFailure(store, 'verify', ipKey, 15 * 60_000);
    throw new HttpError(401, "We couldn't find a match for that information. Check your entries and try again, or contact AWA Insurance.");
  }
  if (matches.length > 1) throw new HttpError(409, 'We need to verify your identity another way. Please contact AWA Insurance to complete your form.');
  await clearLimit(store, 'verify', ipKey);
  const emp = matches[0];

  const existing = await store.getSecretJSON(keys.submission(slug, emp.id));
  if (existing) throw new HttpError(409, `Your form was already submitted on ${new Date(existing.signedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York' })}. If you need to make a change, please contact AWA Insurance.`);

  const expiresAt = Date.now() + cfg.sessionMinutes * 60_000;
  const token = signToken(cfg.appSecret, { t: 'emp', s: slug, e: emp.id, v: Date.now(), exp: expiresAt });
  // Only the yellow (prefill) fields go to the browser — never the SSN or date of birth.
  return json(200, { token, expiresAt, employee: { name: emp.name, address: emp.address, current: emp.current } });
}

async function submitAgreement(req, context, store, cfg) {
  const body = await readJson(req, 1_500_000);
  const session = verifyToken(cfg.appSecret, body.token, 'emp');
  if (!session) throw new HttpError(401, 'Your session expired. Please start over.', { restart: true });
  const slug = session.s;
  const company = await loadCompany(store, slug);
  if (!company || !company.active) throw new HttpError(404, 'This enrollment link is not active.');
  const roster = await store.getSecretJSON(keys.roster(slug));
  const emp = roster?.employees?.find((e) => e.id === session.e);
  if (!emp) throw new HttpError(409, 'Your record changed. Please start over.', { restart: true });
  if (await store.getSecretJSON(keys.submission(slug, emp.id))) throw new HttpError(409, 'This form was already submitted.', { restart: true });

  const tiers = allTiers(company);
  const tierByKey = new Map(tiers.map((t) => [t.key, t]));
  const decision = body.decision;
  if (decision !== 'enroll' && decision !== 'waive') throw new HttpError(400, 'Choose whether you are enrolling or declining benefits.');

  let selections = [];
  let waiverReasons = [];
  if (decision === 'enroll') {
    selections = Array.isArray(body.selections) ? [...new Set(body.selections.map(String))] : [];
    if (!selections.length) throw new HttpError(400, 'Select a plan and coverage level.');
    const groupsUsed = new Set();
    for (const key of selections) {
      const t = tierByKey.get(key);
      if (!t) throw new HttpError(400, 'One of your selections is no longer available. Please start over.', { restart: true });
      if (groupsUsed.has(t.groupIndex)) throw new HttpError(400, 'Select only one coverage level per plan section.');
      groupsUsed.add(t.groupIndex);
    }
  } else {
    waiverReasons = Array.isArray(body.waiverReasons) ? [...new Set(body.waiverReasons.map(String))] : [];
    if (!waiverReasons.length) throw new HttpError(400, 'Check at least one reason for declining.');
    if (waiverReasons.some((r) => !company.waiverReasons.includes(r))) throw new HttpError(400, 'Invalid reason selected.');
  }

  if (body.consent !== true) throw new HttpError(400, 'Please agree to sign electronically.');
  const sig = String(body.signature || '');
  if (!sig.startsWith('data:image/png;base64,') || sig.length > 600_000) throw new HttpError(400, 'Please sign the form.');
  const sigBytes = Buffer.from(sig.slice(22), 'base64');
  if (!isPng(sigBytes) || sigBytes.length < 200) throw new HttpError(400, 'Please sign the form.');

  const correctionAddress = String(body.correctionAddress || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const now = new Date();
  const submission = {
    employeeId: emp.id,
    employee: { name: emp.name, dob: emp.dob, ssn: emp.ssn, address: emp.address, current: emp.current },
    correctionAddress,
    decision,
    selections,
    waiverReasons,
    signature: sig,
    signedAt: now.toISOString(),
    confirmation: confirmationCode(),
    template: company,
    audit: { ip: clientIp(req, context), userAgent: (req.headers.get('user-agent') || '').slice(0, 300), sessionStarted: new Date(session.v).toISOString() },
    email: { status: 'pending' },
  };
  await store.setSecretJSON(keys.submission(slug, emp.id), submission);

  const pdfBytes = await renderAgreementPdf({ template: company, submission });
  await store.setSecretBytes(keys.pdf(slug, emp.id), pdfBytes);
  submission.email = await emailSignedAgreement({ to: company.notifyEmail, template: company, submission, pdfBytes });
  await store.setSecretJSON(keys.submission(slug, emp.id), submission);

  return json(200, { confirmation: submission.confirmation, signedAt: submission.signedAt });
}

// ---------- admin routes ----------
async function adminLogin(req, context, store, cfg) {
  const body = await readJson(req, 5_000);
  const ipKey = hashForKey(cfg.appSecret, clientIp(req, context));
  await checkLimit(store, 'admin', ipKey, 10);
  if (!safeEqualString(String(body.password || ''), cfg.adminPassword)) {
    await recordFailure(store, 'admin', ipKey, 15 * 60_000);
    throw new HttpError(401, 'Incorrect password.');
  }
  await clearLimit(store, 'admin', ipKey);
  const expiresAt = Date.now() + cfg.adminSessionHours * 3_600_000;
  return json(200, { token: signToken(cfg.appSecret, { t: 'adm', exp: expiresAt }), expiresAt });
}

async function adminStatus(cfg) {
  return json(200, {
    emailConfigured: Boolean(cfg.smtp.host && cfg.mailFrom),
    defaultNotifyEmail: cfg.notifyEmail || '',
    defaultTemplate: defaultTemplate(),
  });
}

async function companySummary(store, company) {
  const roster = await store.getSecretJSON(keys.roster(company.slug));
  const subs = await loadSubmissions(store, company.slug);
  return {
    template: company,
    roster: roster ? { uploadedAt: roster.uploadedAt, fileName: roster.fileName, report: roster.report } : null,
    stats: {
      employees: roster?.employees?.length || 0,
      submitted: subs.length,
      enrolled: subs.filter((s) => s.decision === 'enroll').length,
      waived: subs.filter((s) => s.decision === 'waive').length,
    },
  };
}

async function listCompanies(store) {
  const list = await store.list(keys.companiesPrefix);
  const companies = (await Promise.all(list.map((k) => store.getJSON(k)))).filter(Boolean);
  const out = await Promise.all(companies.map((c) => companySummary(store, c)));
  out.sort((a, b) => a.template.companyName.localeCompare(b.template.companyName));
  return json(200, { companies: out });
}

async function reparseRoster(store, cfg, company) {
  const raw = await store.getSecretBytes(`rosterfile/${company.slug}`);
  if (!raw) return null;
  const prev = await store.getSecretJSON(keys.roster(company.slug));
  const { employees, report } = await parseRoster(raw, company, cfg.appSecret);
  const roster = { uploadedAt: prev?.uploadedAt || new Date().toISOString(), fileName: prev?.fileName || 'Current Redirection.xlsx', employees, report };
  await store.setSecretJSON(keys.roster(company.slug), roster);
  return roster;
}

async function saveCompany(req, store, cfg, slugFromPath) {
  const body = await readJson(req, 200_000);
  const { template, errors } = cleanTemplate(body.template);
  if (slugFromPath && template.slug !== slugFromPath) errors.push('The link name cannot be changed after a company is created.');
  if (errors.length) throw new HttpError(400, errors[0], { errors });
  const existing = await store.getJSON(keys.company(template.slug));
  if (!slugFromPath && existing) throw new HttpError(409, `The link name "${template.slug}" is already used by ${existing.companyName}.`);
  if (slugFromPath && !existing) throw new HttpError(404, 'Company not found.');
  template.updatedAt = new Date().toISOString();
  template.createdAt = existing?.createdAt || template.updatedAt;
  await store.setJSON(keys.company(template.slug), template);
  let rosterNote = null;
  try { const r = await reparseRoster(store, cfg, template); if (r) rosterNote = r.report; } catch (e) { rosterNote = { error: e.message }; }
  return json(200, { ...(await companySummary(store, template)), rosterRecheck: rosterNote });
}

async function deleteCompany(req, store, slug) {
  const url = new URL(req.url);
  if (url.searchParams.get('confirm') !== slug) throw new HttpError(400, 'Confirmation did not match.');
  const toDelete = [
    keys.company(slug), keys.roster(slug), `rosterfile/${slug}`,
    ...(await store.list(keys.submissionsPrefix(slug))),
    ...(await store.list(`pdfs/${slug}/`)),
  ];
  for (const k of toDelete) await store.delete(k);
  return json(200, { deleted: true });
}

async function uploadRoster(req, store, cfg, company) {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (!buf.length) throw new HttpError(400, 'Choose a spreadsheet to upload.');
  if (buf.length > 5_000_000) throw new HttpError(413, 'Spreadsheet is too large (max 5 MB).');
  let parsed;
  try { parsed = await parseRoster(buf, company, cfg.appSecret); } catch (e) { throw new HttpError(400, e.message); }
  if (!parsed.employees.length) throw new HttpError(400, 'No employees were found in that spreadsheet.', { report: parsed.report });
  const fileName = (req.headers.get('x-file-name') || 'Current Redirection.xlsx').slice(0, 200);
  await store.setSecretBytes(`rosterfile/${company.slug}`, buf);
  await store.setSecretJSON(keys.roster(company.slug), { uploadedAt: new Date().toISOString(), fileName, employees: parsed.employees, report: parsed.report });
  return json(200, { report: parsed.report });
}

async function listPeople(store, company) {
  const roster = await store.getSecretJSON(keys.roster(company.slug));
  const subs = await loadSubmissions(store, company.slug);
  const subById = new Map(subs.map((s) => [s.employeeId, s]));
  const tiers = new Map(allTiers(company).map((t) => [t.key, t]));
  const describe = (s) => (s.decision === 'enroll'
    ? s.selections.map((k) => { const t = tiers.get(k) || s.template && allTiers(s.template).find((x) => x.key === k); return t ? `${t.optionName} – ${t.label}` : k; }).join('; ')
    : `Declined: ${s.waiverReasons.join(', ')}`);
  const row = (id, name, s) => ({
    id, name,
    status: s ? (s.decision === 'enroll' ? 'Enrolled' : 'Waived') : 'Not submitted',
    detail: s ? describe(s) : '',
    correctionAddress: s?.correctionAddress || '',
    signedAt: s?.signedAt || null,
    confirmation: s?.confirmation || null,
    email: s?.email || null,
    inRoster: true,
  });
  const people = (roster?.employees || []).map((e) => { const s = subById.get(e.id); subById.delete(e.id); return row(e.id, e.name, s); });
  for (const s of subById.values()) people.push({ ...row(s.employeeId, s.employee.name, s), inRoster: false });
  return json(200, { people });
}

async function exportSheet(store, company) {
  const roster = await store.getSecretJSON(keys.roster(company.slug));
  const subs = await loadSubmissions(store, company.slug);
  const bytes = await buildExport(company, roster?.employees || [], subs);
  const date = new Date().toISOString().slice(0, 10);
  return file(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', `Open Enrollment Redirection - ${company.companyName} - ${date}.xlsx`);
}

async function getPdf(store, company, id) {
  const sub = await store.getSecretJSON(keys.submission(company.slug, id));
  if (!sub) throw new HttpError(404, 'Submission not found.');
  let bytes = await store.getSecretBytes(keys.pdf(company.slug, id));
  if (!bytes) { bytes = await renderAgreementPdf({ template: sub.template || company, submission: sub }); await store.setSecretBytes(keys.pdf(company.slug, id), bytes); }
  return file(bytes, 'application/pdf', `Redirection Agreement - ${sub.employee.name}.pdf`);
}

async function resendEmail(store, company, id) {
  const sub = await store.getSecretJSON(keys.submission(company.slug, id));
  if (!sub) throw new HttpError(404, 'Submission not found.');
  let bytes = await store.getSecretBytes(keys.pdf(company.slug, id));
  if (!bytes) bytes = await renderAgreementPdf({ template: sub.template || company, submission: sub });
  sub.email = await emailSignedAgreement({ to: company.notifyEmail, template: sub.template || company, submission: sub, pdfBytes: bytes });
  await store.setSecretJSON(keys.submission(company.slug, id), sub);
  return json(200, { email: sub.email });
}

async function resetSubmission(store, company, id) {
  await store.delete(keys.submission(company.slug, id));
  await store.delete(keys.pdf(company.slug, id));
  return json(200, { reset: true });
}

// ---------- router ----------
export default async function handler(req, context) {
  const cfg = getConfig();
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();
  try {
    const missing = assertConfigured(cfg);
    if (missing.length) throw new HttpError(500, `Server setup incomplete. Set these Netlify environment variables: ${missing.join(', ')}.`);
    const store = await openStore(cfg.appSecret);
    let m;

    if (method === 'GET' && (m = /^\/company\/([a-z0-9-]+)$/.exec(path))) return await getCompanyPublic(store, m[1]);
    if (method === 'POST' && path === '/verify') return await verifyEmployee(req, context, store, cfg);
    if (method === 'POST' && path === '/submit') return await submitAgreement(req, context, store, cfg);
    if (method === 'POST' && path === '/admin/login') return await adminLogin(req, context, store, cfg);

    if (path.startsWith('/admin/')) {
      requireAdmin(req, cfg);
      if (method === 'GET' && path === '/admin/status') return await adminStatus(cfg);
      if (method === 'GET' && path === '/admin/companies') return await listCompanies(store);
      if (method === 'POST' && path === '/admin/companies') return await saveCompany(req, store, cfg, null);
      if ((m = /^\/admin\/companies\/([a-z0-9-]+)(\/.*)?$/.exec(path))) {
        const slug = m[1];
        const sub = m[2] || '';
        if (method === 'PUT' && !sub) return await saveCompany(req, store, cfg, slug);
        if (method === 'DELETE' && !sub) return await deleteCompany(req, store, slug);
        const company = await loadCompany(store, slug);
        if (!company) throw new HttpError(404, 'Company not found.');
        if (method === 'POST' && sub === '/roster') return await uploadRoster(req, store, cfg, company);
        if (method === 'GET' && sub === '/people') return await listPeople(store, company);
        if (method === 'GET' && sub === '/export') return await exportSheet(store, company);
        let s;
        if ((s = /^\/submissions\/([a-f0-9]{24})(\/pdf|\/resend)?$/.exec(sub))) {
          if (method === 'GET' && s[2] === '/pdf') return await getPdf(store, company, s[1]);
          if (method === 'POST' && s[2] === '/resend') return await resendEmail(store, company, s[1]);
          if (method === 'DELETE' && !s[2]) return await resetSubmission(store, company, s[1]);
        }
      }
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message, ...e.extra });
    console.error(e);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
}
