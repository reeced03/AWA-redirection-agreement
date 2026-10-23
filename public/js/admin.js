// AWA admin: companies, per-company agreement templates, roster upload, employee status, QR codes, export.
import { el, api, tierKey } from './common.js';
import { qrCanvas } from './qr.js';

const app = document.getElementById('app');
const signOutBtn = document.getElementById('signOut');
let token = null;
let status = null; // { emailConfigured, defaultNotifyEmail, defaultTemplate }
let companies = [];

try { token = sessionStorage.getItem('awa-admin-token'); } catch { /* storage unavailable */ }

function saveToken(t) {
  token = t;
  try { t ? sessionStorage.setItem('awa-admin-token', t) : sessionStorage.removeItem('awa-admin-token'); } catch { /* ignore */ }
}

async function call(url, opts = {}) {
  try {
    return await api(url, { ...opts, token });
  } catch (err) {
    if (err.status === 401 && url !== '/api/admin/login') { saveToken(null); loginView('Your session ended. Please sign in again.'); }
    throw err;
  }
}

async function download(url, fallbackName) {
  const res = await call(url);
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') || '';
  const name = (/filename="([^"]+)"/.exec(cd) || [])[1] || fallbackName;
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

const linkFor = (slug) => `${location.origin}/e/${slug}`;
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const alertEl = (type, ...children) => el('div', { class: `alert ${type}`, role: 'status' }, ...children);

function view(...children) { app.replaceChildren(...children); window.scrollTo({ top: 0 }); }

// ------------------------------------------------------------------ login
function loginView(message) {
  signOutBtn.hidden = true;
  const pw = el('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true });
  const box = el('div', { hidden: !message }, message ? alertEl('info', message) : '');
  const btn = el('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Sign in');
  const form = el('form', { class: 'sheet login' },
    el('h1', { style: 'margin:0 0 6px;font-size:26px' }, 'Admin sign in'),
    el('p', { class: 'small' }, 'Manage companies, agreement forms and enrollment spreadsheets.'),
    el('div', { class: 'field' }, el('label', { for: 'pw' }, 'Password'), pw),
    box, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    try {
      const res = await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
      saveToken(res.token);
      route();
    } catch (err) {
      box.replaceChildren(alertEl('', err.message));
      box.hidden = false;
      btn.disabled = false;
      pw.select();
    }
  });
  view(form);
  pw.focus();
}

signOutBtn.addEventListener('click', () => { saveToken(null); location.hash = '#/'; loginView('You signed out.'); });

// ------------------------------------------------------------------ data
async function loadAll() {
  const [s, c] = await Promise.all([call('/api/admin/status'), call('/api/admin/companies')]);
  status = s;
  companies = c.companies;
}
const findCompany = (slug) => companies.find((c) => c.template.slug === slug);

// ------------------------------------------------------------------ list
function listView(flash) {
  const head = el('div', { class: 'page-head' },
    el('div', {}, el('h1', {}, 'Companies'), el('p', {}, 'Each company has its own agreement form, QR code and spreadsheets.')),
    el('a', { class: 'btn btn-primary', href: '#/new' }, 'Add a company'));
  const notices = [];
  if (flash) notices.push(alertEl('ok', flash));
  if (!status.emailConfigured) notices.push(alertEl('warn', el('strong', {}, 'Email isn’t set up yet. '), 'Signed agreements are saved here, but won’t be emailed until SMTP settings are added in Netlify (see README).'));

  if (!companies.length) {
    return view(head, ...notices, el('div', { class: 'sheet empty' },
      el('h2', {}, 'No companies yet'),
      el('p', {}, 'Add your first company to set up its agreement form, then upload its Current Redirection spreadsheet.'),
      el('a', { class: 'btn btn-primary', href: '#/new' }, 'Add a company')));
  }
  const list = el('div', { class: 'company-list' }, ...companies.map(({ template: t, stats, roster }) => {
    const pct = stats.employees ? Math.round((stats.submitted / stats.employees) * 100) : 0;
    return el('article', { class: `company${t.active ? '' : ' inactive'}` },
      el('div', {},
        el('h2', {}, t.companyName, t.active ? '' : el('span', { class: 'pill' }, 'Link off'), roster ? '' : el('span', { class: 'pill red' }, 'No spreadsheet')),
        el('div', { class: 'link' }, linkFor(t.slug)),
        el('div', { class: 'stats' },
          el('span', {}, el('b', {}, String(stats.submitted)), ` of ${stats.employees} signed`),
          el('span', {}, `${stats.enrolled} enrolled`),
          el('span', {}, `${stats.waived} declined`)),
        stats.employees ? el('div', { class: 'progress', 'aria-hidden': 'true' }, el('span', { style: `width:${pct}%` })) : ''),
      el('div', { class: 'row-actions' },
        el('a', { class: 'btn btn-quiet', href: `#/c/${t.slug}/people` }, 'Employees'),
        el('a', { class: 'btn btn-quiet', href: `#/c/${t.slug}/edit` }, 'Edit form'),
        el('a', { class: 'btn btn-quiet', href: `#/c/${t.slug}/roster` }, roster ? 'Replace spreadsheet' : 'Upload spreadsheet'),
        el('a', { class: 'btn btn-quiet', href: `#/c/${t.slug}/qr` }, 'QR code'),
        el('button', { class: 'btn', onclick: () => download(`/api/admin/companies/${t.slug}/export`, 'Open Enrollment Redirection.xlsx') }, 'Download Open Enrollment sheet')));
  }));
  view(head, ...notices, list);
}

// ------------------------------------------------------------------ editor
function slugify(s) {
  return s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

function editorView(existing) {
  const isNew = !existing;
  const base = structuredClone(existing ? existing.template : status.defaultTemplate);
  if (isNew) { base.slug = ''; base.companyName = ''; base.notifyEmail = status.defaultNotifyEmail || ''; }
  let t = base;
  let slugTouched = !isNew;

  const errorsBox = el('div');
  const container = el('div', { class: 'editor' });

  const bindText = (obj, key, attrs = {}, multiline = false) => {
    const input = el(multiline ? 'textarea' : 'input', { type: multiline ? undefined : 'text', ...attrs });
    input.value = obj[key] ?? '';
    input.addEventListener('input', () => { obj[key] = input.value; });
    return input;
  };
  const fieldRow = (label, input, hint) => {
    const id = `f-${Math.random().toString(36).slice(2, 9)}`;
    input.id = id;
    return el('div', { class: 'field' }, el('label', { for: id }, label), input, hint ? el('div', { class: 'hint' }, hint) : '');
  };

  function render() {
    // ---- basics
    const nameInput = bindText(t, 'companyName', { maxlength: 120, required: true });
    const slugInput = bindText(t, 'slug', { maxlength: 40, disabled: !isNew, pattern: '[a-z0-9-]+' });
    const slugHint = el('span', {}, linkFor(t.slug || 'company-name'));
    nameInput.addEventListener('input', () => {
      if (!slugTouched) { t.slug = slugify(nameInput.value); slugInput.value = t.slug; slugHint.textContent = linkFor(t.slug || 'company-name'); }
    });
    slugInput.addEventListener('input', () => { slugTouched = true; t.slug = slugInput.value = slugify(slugInput.value); slugHint.textContent = linkFor(t.slug || 'company-name'); });
    const active = el('input', { type: 'checkbox' });
    active.checked = t.active !== false;
    active.addEventListener('change', () => { t.active = active.checked; });

    let copySelect = '';
    if (isNew && companies.length) {
      copySelect = el('select', { id: 'copyFrom' },
        el('option', { value: '' }, 'AWA standard form (sample agreement)'),
        ...companies.map((c) => el('option', { value: c.template.slug }, `Copy of ${c.template.companyName}`)));
      copySelect.addEventListener('change', () => {
        const src = copySelect.value ? findCompany(copySelect.value).template : status.defaultTemplate;
        const keep = { companyName: t.companyName, slug: t.slug, notifyEmail: t.notifyEmail };
        t = { ...structuredClone(src), ...keep, active: true };
        render();
        container.querySelector('#copyFrom').value = copySelect.value;
      });
    }

    const basics = el('section', { class: 'panel' },
      el('h2', {}, 'Company'),
      el('p', { class: 'small' }, 'The company name appears on the form wherever the wording uses {{company}}.'),
      copySelect ? el('div', { class: 'field' }, el('label', { for: 'copyFrom' }, 'Start from'), copySelect) : '',
      el('div', { class: 'grid2' },
        fieldRow('Company name', nameInput),
        fieldRow('Link name', slugInput, isNew ? slugHint : el('span', {}, linkFor(t.slug), ' (can’t be changed)'))),
      fieldRow('Email signed agreements to', bindText(t, 'notifyEmail', { type: 'text', placeholder: status.defaultNotifyEmail || 'benefits@awainsurance.com' }),
        'Separate several addresses with commas. Leave blank to use the default address.'),
      el('label', { class: 'toggle' }, active, 'Form link is on (employees can open and sign)'));

    // ---- wording
    const wording = el('section', { class: 'panel' },
      el('h2', {}, 'Agreement wording'),
      el('p', { class: 'ph' }, 'Placeholders: ', el('code', {}, '{{company}}'), ' ', el('code', {}, '{{startDate}}'), ' ', el('code', {}, '{{anniversaryDate}}'), '. Wrap words in ', el('code', {}, '**double stars**'), ' to make them bold.'),
      fieldRow('Form title', bindText(t, 'title', { maxlength: 200 })),
      fieldRow('Subtitle', bindText(t, 'subtitle', { maxlength: 200 })),
      fieldRow('Opening paragraph', bindText(t, 'intro', { maxlength: 3000 }, true)),
      el('div', { class: 'grid2' },
        fieldRow('Deductions begin ({{startDate}})', bindText(t, 'startDate', { maxlength: 40, placeholder: 'e.g. 03/01/2027' })),
        fieldRow('Plan anniversary date ({{anniversaryDate}})', bindText(t, 'anniversaryDate', { maxlength: 40, placeholder: 'e.g. 03/01/2028' }))),
      fieldRow('Enrollment heading', bindText(t, 'enrollmentHeading', { maxlength: 120 })),
      fieldRow('Enrollment agreement', bindText(t, 'enrollmentText', { maxlength: 3000 }, true)),
      fieldRow('Irrevocable election', bindText(t, 'irrevocableText', { maxlength: 3000 }, true)),
      fieldRow('Waiver heading', bindText(t, 'waiverHeading', { maxlength: 120 })),
      fieldRow('Waiver statement', bindText(t, 'waiverText', { maxlength: 3000 }, true)),
      fieldRow('Form date (bottom of form)', bindText(t, 'formDate', { maxlength: 40 })));

    // ---- plans
    const plansBody = el('div');
    const renderPlans = () => {
      plansBody.replaceChildren(...t.planGroups.map((g, gi) => {
        const optsBody = el('div');
        g.options.forEach((o, oi) => {
          const tiersBody = el('div', { class: 'tiers' },
            el('div', { class: 'tier-cols', 'aria-hidden': 'true' }, el('div', {}, 'Coverage level'), el('div', {}, 'Spreadsheet column'), el('div', {})),
            ...o.tiers.map((tr, ti) => el('div', { class: 'tier-row' },
              bindText(tr, 'label', { maxlength: 80, 'aria-label': 'Coverage level', placeholder: 'e.g. Employee & Spouse' }),
              bindText(tr, 'column', { maxlength: 60, 'aria-label': 'Spreadsheet column', placeholder: 'e.g. FB 1 ES' }),
              el('button', { type: 'button', class: 'btn btn-quiet icon-btn btn-danger', 'aria-label': `Remove ${tr.label || 'tier'}`, onclick: () => { o.tiers.splice(ti, 1); renderPlans(); } }, 'Remove'))),
            el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { o.tiers.push({ label: '', column: '' }); renderPlans(); } }, '+ Add coverage level'));
          optsBody.append(el('div', { class: 'opt' },
            el('div', { class: 'opt-head' },
              el('div', { class: 'field' }, el('label', {}, 'Plan option'), bindText(o, 'name', { maxlength: 160, placeholder: 'e.g. Option 1: BlueCare 14256' })),
              el('div', { class: 'field' }, el('label', {}, 'Note (optional)'), bindText(o, 'note', { maxlength: 200, placeholder: 'e.g. See Deduction Worksheet Attached' })),
              el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => { g.options.splice(oi, 1); renderPlans(); } }, 'Remove option')),
            tiersBody));
        });
        return el('div', { class: 'pg' },
          el('div', { class: 'pg-head' },
            el('div', { class: 'field' }, el('label', {}, 'Plan section heading'), bindText(g, 'heading', { maxlength: 160, placeholder: 'e.g. Florida Blue - Medical Plan(s)' })),
            el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => { t.planGroups.splice(gi, 1); renderPlans(); } }, 'Remove section')),
          optsBody,
          el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { g.options.push({ name: '', note: '', tiers: [{ label: 'Employee', column: '' }] }); renderPlans(); } }, '+ Add plan option'));
      }));
    };
    renderPlans();
    const plans = el('section', { class: 'panel' },
      el('h2', {}, 'Plans and coverage levels'),
      el('p', { class: 'small' }, 'Each coverage level is one row on the form. Its spreadsheet column must match a column header in the Current Redirection sheet (shown in yellow as the current enrollment) and becomes the column in the Open Enrollment Redirection sheet where the employee’s selection is marked with an X. Employees pick one coverage level per section.'),
      plansBody,
      el('button', { type: 'button', class: 'btn', onclick: () => { t.planGroups.push({ heading: '', options: [{ name: '', note: '', tiers: [{ label: 'Employee', column: '' }] }] }); renderPlans(); } }, 'Add plan section'));

    // ---- waiver reasons
    const reasonsBody = el('div');
    const renderReasons = () => {
      reasonsBody.replaceChildren(...t.waiverReasons.map((r, i) => {
        const input = el('input', { type: 'text', maxlength: 80, 'aria-label': `Reason ${i + 1}` });
        input.value = r;
        input.addEventListener('input', () => { t.waiverReasons[i] = input.value; });
        return el('div', { class: 'reason-row' }, input, el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => { t.waiverReasons.splice(i, 1); renderReasons(); } }, 'Remove'));
      }));
    };
    renderReasons();
    const waiver = el('section', { class: 'panel' },
      el('h2', {}, 'Reasons for declining'),
      el('p', { class: 'small' }, 'Employees who decline check one or more of these.'),
      reasonsBody,
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { t.waiverReasons.push(''); renderReasons(); } }, '+ Add reason'));

    // ---- actions
    const saveBtn = el('button', { type: 'button', class: 'btn btn-primary' }, isNew ? 'Create company' : 'Save changes');
    saveBtn.addEventListener('click', () => save(saveBtn));
    const previewBtn = el('button', { type: 'button', class: 'btn' }, 'Preview form');
    previewBtn.addEventListener('click', preview);
    const actions = el('div', { class: 'sticky-actions' }, saveBtn, previewBtn, el('a', { class: 'btn btn-quiet', href: '#/' }, 'Cancel'),
      !isNew ? el('button', { type: 'button', class: 'btn btn-quiet btn-danger', style: 'margin-left:auto', onclick: removeCompany }, 'Delete company') : '');

    container.replaceChildren(basics, wording, plans, waiver);
    view(el('a', { class: 'back', href: '#/' }, '‹ All companies'),
      el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, isNew ? 'Add a company' : `Edit form: ${t.companyName}`),
        el('p', {}, 'The yellow fields (name, address, current enrollment) always fill in from the Current Redirection sheet. The blue fields (address correction, selections or waiver, signature) are always collected and exported.'))),
      errorsBox, container, actions);
  }

  function cleaned() {
    const copy = structuredClone(t);
    copy.waiverReasons = copy.waiverReasons.map((r) => r.trim()).filter(Boolean);
    return copy;
  }

  async function save(btn) {
    btn.disabled = true;
    errorsBox.replaceChildren();
    try {
      const res = await call(isNew ? '/api/admin/companies' : `/api/admin/companies/${t.slug}`, { method: isNew ? 'POST' : 'PUT', body: { template: cleaned() } });
      await loadAll();
      const rr = res.rosterRecheck;
      if (isNew) { location.hash = `#/c/${res.template.slug}/roster`; return; }
      const msgs = [alertEl('ok', 'Saved. The live form now uses these changes.')];
      if (rr?.missingTierColumns?.length) msgs.push(alertEl('warn', `These spreadsheet columns aren’t in the uploaded Current Redirection sheet, so their current enrollment will show blank: ${rr.missingTierColumns.join(', ')}.`));
      if (rr?.error) msgs.push(alertEl('warn', `The uploaded spreadsheet couldn’t be re-read with this form: ${rr.error}`));
      errorsBox.replaceChildren(...msgs);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const list = err.data?.errors || [err.message];
      errorsBox.replaceChildren(alertEl('', el('strong', {}, 'Fix these before saving:'), el('ul', {}, ...list.map((m) => el('li', {}, m)))));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      btn.disabled = false;
    }
  }

  function preview() {
    const tpl = cleaned();
    const current = {};
    const first = tpl.planGroups[0]?.options[0]?.tiers[0];
    if (first) current[tierKey(first.column)] = 'Current';
    const employee = { name: 'Jordan Sample', address: '123 Example Street, Fort Myers FL 33912', current };
    const win = window.open('/form.html?preview=1', 'awa-preview');
    if (!win) { errorsBox.replaceChildren(alertEl('warn', 'Allow pop-ups for this site to open the preview.')); return; }
    const onMsg = (e) => {
      if (e.origin !== location.origin || e.source !== win || e.data?.type !== 'awa-preview-ready') return;
      win.postMessage({ type: 'awa-preview', template: tpl, employee }, location.origin);
    };
    window.addEventListener('message', onMsg);
    setTimeout(() => window.removeEventListener('message', onMsg), 60_000);
  }

  async function removeCompany() {
    const answer = prompt(`This permanently deletes ${t.companyName}, its spreadsheet and all signed agreements. Download the Open Enrollment sheet first if you need it.\n\nType the link name "${t.slug}" to confirm:`);
    if (answer === null) return;
    if (answer.trim() !== t.slug) { alert('That didn’t match, so nothing was deleted.'); return; }
    try {
      await call(`/api/admin/companies/${t.slug}?confirm=${encodeURIComponent(t.slug)}`, { method: 'DELETE' });
      await loadAll();
      location.hash = '#/';
      listView(`${t.companyName} was deleted.`);
    } catch (err) { alert(err.message); }
  }

  render();
}

// ------------------------------------------------------------------ roster upload
function rosterView(c) {
  const t = c.template;
  const result = el('div', { class: 'report' }, c.roster ? reportEl(c.roster.report, `Current file: ${c.roster.fileName}, uploaded ${fmtDate(c.roster.uploadedAt)}`) : '');
  const fileInput = el('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
  const drop = el('div', { class: 'drop', tabindex: '0', role: 'button', 'aria-label': 'Choose the Current Redirection spreadsheet' },
    el('p', { style: 'margin:0 0 6px;font-weight:700' }, 'Drop the Current Redirection spreadsheet here'),
    el('p', { class: 'small', style: 'margin:0 auto' }, 'or click to choose an .xlsx file'));
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) upload(fileInput.files[0]); });

  async function upload(f) {
    if (!/\.xlsx$/i.test(f.name)) { result.replaceChildren(alertEl('', 'Choose an Excel .xlsx file. If it’s .xls or .csv, open it in Excel and save as .xlsx.')); return; }
    result.replaceChildren(alertEl('info', `Reading ${f.name}…`));
    try {
      const res = await call(`/api/admin/companies/${t.slug}/roster`, { method: 'POST', raw: await f.arrayBuffer(), headers: { 'content-type': 'application/octet-stream', 'x-file-name': f.name } });
      await loadAll();
      result.replaceChildren(reportEl(res.report, `Uploaded ${f.name}.`, true));
    } catch (err) {
      result.replaceChildren(alertEl('', err.message), err.data?.report ? reportEl(err.data.report) : '');
    }
    fileInput.value = '';
  }

  const columns = ['Name', 'Date of Birth', 'SS#', 'Current Address', ...t.planGroups.flatMap((g) => g.options.flatMap((o) => o.tiers.map((x) => x.column)))];
  view(el('a', { class: 'back', href: '#/' }, '‹ All companies'),
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, `Spreadsheet: ${t.companyName}`),
      el('p', {}, 'Upload the Current Redirection sheet. Employees verify against it, and it fills in the yellow fields on their form. Uploading again replaces it; signed agreements are kept.'))),
    el('section', { class: 'panel' },
      el('h2', {}, 'Columns this form reads'),
      el('p', { class: 'small' }, 'The first row must be headers. Column order doesn’t matter. Extra columns are ignored.'),
      el('p', {}, columns.join('  |  ')),
      drop, fileInput, result,
      el('div', { class: 'actions' }, el('a', { class: 'btn', href: `#/c/${t.slug}/qr` }, 'Get the QR code'), el('a', { class: 'btn btn-quiet', href: `#/c/${t.slug}/edit` }, 'Edit form'))));
}

function reportEl(r, title, fresh = false) {
  const items = [];
  if (r.missingColumns?.length) items.push(el('li', {}, `Missing columns: ${r.missingColumns.join(', ')}`));
  if (r.missingTierColumns?.length) items.push(el('li', {}, `Coverage columns not found (current enrollment will be blank): ${r.missingTierColumns.join(', ')}`));
  if (r.skipped?.length) items.push(el('li', {}, `${r.skipped.length} row(s) skipped: `, r.skipped.slice(0, 8).map((s) => `row ${s.row}${s.name ? ` (${s.name})` : ''} ${s.reason}`).join('; '), r.skipped.length > 8 ? '…' : ''));
  if (r.loginConflicts?.length) items.push(el('li', {}, 'These employees share the same SSN last 4 and date of birth, so they can’t verify on their own. Help them complete a paper form: ', r.loginConflicts.map((x) => `row ${x.row} (${x.name})`).join(', ')));
  return el('div', {},
    alertEl(fresh ? 'ok' : 'info', `${title ? `${title} ` : ''}${r.employeeCount} employee${r.employeeCount === 1 ? '' : 's'} ready to sign.`),
    items.length ? alertEl('warn', el('strong', {}, 'Check these:'), el('ul', {}, ...items)) : '');
}

// ------------------------------------------------------------------ employees
async function peopleView(c) {
  const t = c.template;
  view(el('p', { class: 'small' }, 'Loading employees…'));
  let people;
  try { ({ people } = await call(`/api/admin/companies/${t.slug}/people`)); } catch (err) { return view(alertEl('', err.message)); }

  const search = el('input', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search by name' });
  const filter = el('select', { 'aria-label': 'Filter by status' },
    el('option', { value: '' }, 'All statuses'), el('option', { value: 'Not submitted' }, 'Not submitted'),
    el('option', { value: 'Enrolled' }, 'Enrolled'), el('option', { value: 'Waived' }, 'Waived'));
  const tbody = el('tbody');
  const counts = el('span', { class: 'small' });

  const renderRows = () => {
    const q = search.value.trim().toLowerCase();
    const rows = people.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!filter.value || p.status === filter.value));
    counts.textContent = `${rows.length} shown`;
    tbody.replaceChildren(...rows.map((p) => {
      const emailNote = p.email ? (p.email.status === 'sent' ? 'Emailed' : p.email.status === 'failed' ? 'Email failed' : p.email.status === 'skipped' ? 'Not emailed' : '') : '';
      return el('tr', {},
        el('td', {}, el('strong', {}, p.name), p.inRoster ? '' : el('div', { class: 'sub' }, 'Not on the current spreadsheet')),
        el('td', {}, el('span', { class: `pill ${p.status === 'Not submitted' ? '' : 'green'}` }, p.status)),
        el('td', {}, p.detail || '', p.correctionAddress ? el('div', { class: 'sub' }, `New address: ${p.correctionAddress}`) : ''),
        el('td', {}, p.signedAt ? fmtDate(p.signedAt) : '', p.confirmation ? el('div', { class: 'sub' }, `${p.confirmation}${emailNote ? ` · ${emailNote}` : ''}`) : ''),
        el('td', { class: 'actions-cell' }, p.signedAt ? [
          el('button', { class: 'btn btn-quiet', onclick: () => download(`/api/admin/companies/${t.slug}/submissions/${p.id}/pdf`, 'agreement.pdf') }, 'PDF'),
          el('button', { class: 'btn btn-quiet', onclick: async (e) => {
            e.target.disabled = true;
            try { const r = await call(`/api/admin/companies/${t.slug}/submissions/${p.id}/resend`, { method: 'POST' }); p.email = r.email; alert(r.email.status === 'sent' ? `Emailed to ${r.email.to}.` : `Not emailed: ${r.email.detail}`); renderRows(); } catch (err) { alert(err.message); e.target.disabled = false; }
          } }, 'Email again'),
          el('button', { class: 'btn btn-quiet btn-danger', onclick: async () => {
            if (!confirm(`Reset ${p.name}'s agreement? Their signed form is deleted and they can scan the QR code and sign again.`)) return;
            try { await call(`/api/admin/companies/${t.slug}/submissions/${p.id}`, { method: 'DELETE' }); await loadAll(); peopleView(findCompany(t.slug)); } catch (err) { alert(err.message); }
          } }, 'Reset'),
        ] : ''));
    }));
  };
  search.addEventListener('input', renderRows);
  filter.addEventListener('change', renderRows);

  view(el('a', { class: 'back', href: '#/' }, '‹ All companies'),
    el('div', { class: 'page-head' },
      el('div', {}, el('h1', {}, `Employees: ${t.companyName}`), el('p', {}, `${c.stats.submitted} of ${c.stats.employees} signed: ${c.stats.enrolled} enrolled, ${c.stats.waived} declined.`)),
      el('button', { class: 'btn btn-primary', onclick: () => download(`/api/admin/companies/${t.slug}/export`, 'Open Enrollment Redirection.xlsx') }, 'Download Open Enrollment sheet')),
    people.length ? el('div', {},
      el('div', { class: 'filters' }, search, filter, counts),
      el('div', { class: 'table-wrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Employee'), el('th', {}, 'Status'), el('th', {}, 'Selection'), el('th', {}, 'Signed'), el('th', {}, ''))),
        tbody)))
      : el('div', { class: 'sheet empty' }, el('h2', {}, 'No employees yet'), el('p', {}, 'Upload the Current Redirection spreadsheet to load employees.'), el('a', { class: 'btn btn-primary', href: `#/c/${t.slug}/roster` }, 'Upload spreadsheet')));
  renderRows();
}

// ------------------------------------------------------------------ QR code
function qrView(c) {
  const t = c.template;
  const url = linkFor(t.slug);
  const canvas = qrCanvas(url, { scale: 16, level: 'Q' });
  const linkInput = el('input', { type: 'text', readonly: true, value: url, 'aria-label': 'Form link' });
  const copyBtn = el('button', { class: 'btn', onclick: async () => {
    try { await navigator.clipboard.writeText(url); copyBtn.textContent = 'Copied'; } catch { linkInput.select(); document.execCommand('copy'); copyBtn.textContent = 'Copied'; }
    setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1600);
  } }, 'Copy link');
  const dl = () => {
    const a = el('a', { href: canvas.toDataURL('image/png'), download: `QR - ${t.companyName}.png` });
    document.body.append(a); a.click(); a.remove();
  };
  const printSign = () => {
    const area = document.getElementById('printArea');
    area.replaceChildren(el('div', { class: 'sign-poster' },
      el('div', { class: 'bar' }),
      el('h1', {}, 'Complete your benefits agreement'),
      el('h2', {}, t.companyName),
      el('img', { class: 'qr', src: canvas.toDataURL('image/png'), alt: 'QR code' }),
      el('ol', {},
        el('li', {}, 'Scan this code with your phone’s camera.'),
        el('li', {}, 'Enter the last 4 of your SSN and your date of birth.'),
        el('li', {}, 'Review your information, make your selection and sign.')),
      el('div', { class: 'url' }, url),
      el('div', { class: 'foot' }, 'AWA Insurance  |  Fort Myers (239) 418-1100  |  Port Charlotte (941) 889-7836')));
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 50);
  };
  view(el('a', { class: 'back', href: '#/' }, '‹ All companies'),
    el('div', { class: 'page-head' }, el('div', {}, el('h1', {}, `QR code: ${t.companyName}`), el('p', {}, 'Employees scan this to open their form.'))),
    !t.active ? alertEl('warn', 'The form link is turned off, so this code won’t work until you turn it on in Edit form.') : '',
    !c.roster ? alertEl('warn', 'Upload the Current Redirection spreadsheet before sharing this code, or employees won’t be able to verify.') : '',
    el('section', { class: 'panel qr-wrap' }, canvas,
      el('div', {},
        el('h2', { style: 'margin-top:0' }, 'Share it'),
        el('div', { class: 'copy-row' }, linkInput, copyBtn),
        el('div', { class: 'actions' },
          el('button', { class: 'btn btn-primary', onclick: printSign }, 'Print a sign'),
          el('button', { class: 'btn', onclick: dl }, 'Download QR image')),
        el('p', { class: 'small', style: 'margin-top:16px' }, 'The code always points to this company’s current form, so you can edit the form wording without reprinting.'))));
}

// ------------------------------------------------------------------ router
async function route() {
  if (!token) return loginView();
  signOutBtn.hidden = false;
  try {
    if (!status) await loadAll();
  } catch (err) {
    if (err.status !== 401) view(alertEl('', err.message));
    return;
  }
  const h = location.hash || '#/';
  let m;
  if (h === '#/new') return editorView(null);
  if ((m = /^#\/c\/([a-z0-9-]+)\/(edit|roster|people|qr)$/.exec(h))) {
    if (m[2] === 'people') await loadAll().catch(() => {});
    const c = findCompany(m[1]);
    if (!c) { location.hash = '#/'; return; }
    if (m[2] === 'edit') return editorView(c);
    if (m[2] === 'roster') return rosterView(c);
    if (m[2] === 'people') return peopleView(c);
    if (m[2] === 'qr') return qrView(c);
  }
  if (h === '#/' || h === '') { await loadAll().catch(() => {}); return listView(); }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
route();
