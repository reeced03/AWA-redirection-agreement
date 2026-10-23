// End-to-end API test against a temporary local data folder.
// Usage: node scripts/smoke-test.mjs <Current Redirection.xlsx> [outDir]
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const rosterPath = process.argv[2];
const outDir = process.argv[3] || os.tmpdir();
if (!rosterPath) { console.error('Usage: node scripts/smoke-test.mjs <Current Redirection.xlsx> [outDir]'); process.exit(1); }

process.env.LOCAL_BLOBS_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'awa-test-'));
process.env.APP_SECRET = 'test-secret-0123456789-0123456789-abcdef';
process.env.ADMIN_PASSWORD = 'test-admin-password';
const { default: handler } = await import('../netlify/functions/api.mjs');
const { defaultTemplate } = await import('../lib/template.mjs');

const call = async (method, p, { body, token, raw, headers = {} } = {}) => {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await handler(new Request(`http://localhost/api${p}`, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) }), { ip: '10.0.0.1' });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : new Uint8Array(await res.arrayBuffer()) };
};

// Admin login
assert.equal((await call('POST', '/admin/login', { body: { password: 'nope' } })).status, 401);
const { data: login } = await call('POST', '/admin/login', { body: { password: 'test-admin-password' } });
const admin = login.token;
assert.equal((await call('GET', '/admin/companies')).status, 401, 'admin routes require auth');

// Create company from the default template
const tpl = { ...defaultTemplate(), slug: 'air-handlers', companyName: 'Air Handlers Cooling & Heating Inc.', startDate: '03/01/2026', notifyEmail: 'benefits@example.com' };
let r = await call('POST', '/admin/companies', { token: admin, body: { template: tpl } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal((await call('POST', '/admin/companies', { token: admin, body: { template: tpl } })).status, 409, 'duplicate slug rejected');
const bad = await call('POST', '/admin/companies', { token: admin, body: { template: { ...tpl, slug: 'x2', planGroups: [] } } });
assert.equal(bad.status, 400);

// Verify before roster upload
assert.equal((await call('POST', '/verify', { body: { slug: 'air-handlers', last4: '6789', dob: '1990-01-01' } })).status, 503);

// Upload roster
r = await call('POST', '/admin/companies/air-handlers/roster', { token: admin, raw: await fs.readFile(rosterPath), headers: { 'x-file-name': 'Current Redirection.xlsx' } });
assert.equal(r.status, 200, JSON.stringify(r.data));
console.log('Roster report:', JSON.stringify(r.data.report));

// Public template
r = await call('GET', '/company/air-handlers');
assert.equal(r.status, 200);
assert.equal(r.data.template.notifyEmail, undefined, 'notify email not exposed publicly');

// Wrong verification
assert.equal((await call('POST', '/verify', { body: { slug: 'air-handlers', last4: '0000', dob: '1990-01-01' } })).status, 401);
// Correct verification (John Smith: SSN 123456789, DOB serial 32874 = 1990-01-01)
r = await call('POST', '/verify', { body: { slug: 'air-handlers', last4: '6789', dob: '1990-01-01' } });
assert.equal(r.status, 200, JSON.stringify(r.data));
assert.equal(r.data.employee.name, 'John Smith');
assert.ok(!JSON.stringify(r.data).includes('123456789'), 'SSN never sent to browser');
console.log('Prefill (yellow):', JSON.stringify(r.data.employee));
const token = r.data.token;

// 1x1 transparent-ish PNG large enough to pass the size check
const sig = 'data:image/png;base64,' + (await fs.readFile(new URL('./fixtures/signature.png', import.meta.url))).toString('base64');

// Invalid submissions
assert.equal((await call('POST', '/submit', { body: { token, decision: 'enroll', selections: [], signature: sig, consent: true } })).status, 400);
assert.equal((await call('POST', '/submit', { body: { token, decision: 'enroll', selections: ['fb1ee', 'fb2es'], signature: sig, consent: true } })).status, 400, 'one tier per section');
assert.equal((await call('POST', '/submit', { body: { token: token + 'x', decision: 'enroll', selections: ['fb1ee'], signature: sig, consent: true } })).status, 401);

// Valid submission
r = await call('POST', '/submit', { body: { token, decision: 'enroll', selections: ['fb2es'], correctionAddress: '456 New Road, Cape Coral FL 33904', signature: sig, consent: true } });
assert.equal(r.status, 200, JSON.stringify(r.data));
console.log('Submitted:', JSON.stringify(r.data));

// Second attempt is blocked
assert.equal((await call('POST', '/verify', { body: { slug: 'air-handlers', last4: '6789', dob: '1990-01-01' } })).status, 409);

// Admin views
r = await call('GET', '/admin/companies/air-handlers/people', { token: admin });
console.log('People:', JSON.stringify(r.data.people));
const id = r.data.people[0].id;
r = await call('GET', `/admin/companies/air-handlers/submissions/${id}/pdf`, { token: admin });
assert.equal(r.status, 200);
await fs.writeFile(path.join(outDir, 'sample-signed-agreement.pdf'), r.data);
r = await call('GET', '/admin/companies/air-handlers/export', { token: admin });
assert.equal(r.status, 200);
await fs.writeFile(path.join(outDir, 'sample-open-enrollment-export.xlsx'), r.data);

// Editing the template re-parses the stored roster
r = await call('GET', '/admin/companies', { token: admin });
const saved = r.data.companies[0].template;
r = await call('PUT', '/admin/companies/air-handlers', { token: admin, body: { template: { ...saved, waiverReasons: [...saved.waiverReasons, 'Other'] } } });
assert.equal(r.status, 200, JSON.stringify(r.data));

// Reset lets the employee submit again
assert.equal((await call('DELETE', `/admin/companies/air-handlers/submissions/${id}`, { token: admin })).status, 200);
assert.equal((await call('POST', '/verify', { body: { slug: 'air-handlers', last4: '6789', dob: '1990-01-01' } })).status, 200);

// Rate limiting: 8 failures then blocked
for (let i = 0; i < 8; i++) await call('POST', '/verify', { body: { slug: 'air-handlers', last4: '1111', dob: '1990-01-01' } });
assert.equal((await call('POST', '/verify', { body: { slug: 'air-handlers', last4: '6789', dob: '1990-01-01' } })).status, 429);

// Stored data is encrypted at rest
const files = await fs.readdir(process.env.LOCAL_BLOBS_DIR);
for (const f of files.filter((f) => /^(rosters|submissions|pdfs|rosterfile)/.test(decodeURIComponent(f)))) {
  const content = await fs.readFile(path.join(process.env.LOCAL_BLOBS_DIR, f));
  assert.ok(!content.includes('John Smith') && !content.includes('123456789'), `${f} must be encrypted`);
}
console.log('\nAll API checks passed. Outputs written to', outDir);
