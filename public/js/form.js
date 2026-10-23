// Employee flow: verify → prefilled agreement (yellow) → selections + signature (blue) → done.
// Nothing is stored in the browser. Leaving or reloading the page means starting over.
import { el, rich, fillPlaceholders, tierKey, api } from './common.js';
import { SignaturePad } from './signature.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const isPreview = params.get('preview') === '1';
const slug = (location.pathname.match(/^\/e\/([a-z0-9-]+)/) || [])[1] || params.get('c') || '';

let template = null;
let session = null; // { token, expiresAt, employee }
let dirty = false;
let expiryTimer = null;

window.addEventListener('beforeunload', (e) => {
  if (dirty && !isPreview) { e.preventDefault(); e.returnValue = ''; }
});

function setCompany(t) {
  document.getElementById('companyContext').textContent = t.companyName;
  document.title = `${t.companyName} – Benefits Redirection Agreement | AWA Insurance`;
}

function screen(...children) {
  app.replaceChildren(...children);
  window.scrollTo({ top: 0 });
}

function errorScreen(message) {
  screen(el('div', { class: 'sheet verify' },
    el('h1', {}, 'This link isn’t working'),
    el('p', { class: 'lead' }, message),
    el('p', {}, 'Please contact AWA Insurance and we’ll help you complete your form.')));
}

// ---------------- Step 1: verify ----------------
function verifyScreen(notice) {
  dirty = false;
  session = null;
  clearTimeout(expiryTimer);
  const alertBox = el('div', { class: notice ? 'alert info' : 'alert', hidden: !notice }, notice || '');
  const last4 = el('input', { type: 'password', id: 'last4', inputmode: 'numeric', autocomplete: 'off', maxlength: '4', pattern: '[0-9]{4}', required: true, 'aria-describedby': 'last4hint' });
  const toggle = el('button', { type: 'button', class: 'btn btn-quiet show', 'aria-pressed': 'false' }, 'Show');
  toggle.addEventListener('click', () => {
    const showing = last4.type === 'text';
    last4.type = showing ? 'password' : 'text';
    toggle.textContent = showing ? 'Show' : 'Hide';
    toggle.setAttribute('aria-pressed', String(!showing));
  });
  last4.addEventListener('input', () => { last4.value = last4.value.replace(/\D/g, '').slice(0, 4); });
  const dob = el('input', { type: 'date', id: 'dob', required: true, max: new Date().toISOString().slice(0, 10), min: '1900-01-01', autocomplete: 'bday' });
  const btn = el('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Continue to my form');

  const form = el('form', { novalidate: true },
    el('div', { class: 'field' },
      el('label', { for: 'last4' }, 'Last 4 digits of your Social Security Number'),
      el('div', { class: 'ssn-row' }, last4, toggle),
      el('div', { class: 'hint', id: 'last4hint' }, 'Only the last 4 digits.')),
    el('div', { class: 'field' },
      el('label', { for: 'dob' }, 'Date of birth'),
      dob),
    alertBox,
    btn);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.hidden = true;
    if (!/^\d{4}$/.test(last4.value)) return showAlert(alertBox, 'Enter the last 4 digits of your Social Security Number.', last4);
    if (!dob.value) return showAlert(alertBox, 'Enter your date of birth.', dob);
    busy(btn, true, 'Checking…');
    try {
      const res = await api('/api/verify', { method: 'POST', body: { slug, last4: last4.value, dob: dob.value } });
      session = res;
      formScreen();
    } catch (err) {
      showAlert(alertBox, err.message);
      busy(btn, false, 'Continue to my form');
    }
  });

  screen(el('div', { class: 'sheet verify' },
    el('h1', {}, 'Your benefits agreement'),
    el('p', { class: 'lead' }, `Confirm who you are to open your ${template.companyName} Redirection Agreement. It takes about 3 minutes.`),
    form,
    el('div', { class: 'privacy' },
      lockIcon(),
      el('div', {}, 'Your information is only used to find your record. If you leave or refresh this page before submitting, you’ll need to start over.'))));
  last4.focus();
}

function lockIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/>';
  return svg;
}

function showAlert(box, msg, focusEl) {
  box.className = 'alert';
  box.textContent = msg;
  box.hidden = false;
  if (focusEl) focusEl.focus();
}

function busy(btn, on, label) {
  btn.disabled = on;
  btn.replaceChildren(...(on ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), label] : [label]));
}

// ---------------- Step 2: the agreement ----------------
function formScreen() {
  const t = template;
  const emp = session.employee;
  dirty = true;
  if (!isPreview) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => verifyScreen('For your security, your session timed out. Please verify again to start over.'), Math.max(0, session.expiresAt - Date.now()));
  }

  const state = { decision: null, selections: new Map(), reasons: new Set() };
  const alertBox = el('div', { class: 'alert', hidden: true, role: 'alert' });

  // --- employee details
  const correction = el('input', { type: 'text', id: 'correction', class: 'hl-blue', autocomplete: 'street-address', maxlength: '300', placeholder: 'Only if your address above is wrong' });
  const details = el('section', {},
    el('div', { class: 'field' }, el('div', { class: 'label' }, 'Employee name'), el('div', { class: 'value hl-yellow' }, emp.name)),
    el('div', { class: 'field' }, el('div', { class: 'label' }, 'Current home address'), el('div', { class: 'value hl-yellow' }, emp.address || '—')),
    el('div', { class: 'field' }, el('label', { for: 'correction' }, 'Home address correction'), correction));

  // --- decision
  const decisionBox = el('div', { class: 'decision', role: 'radiogroup', 'aria-label': 'Your choice' },
    choice('enroll', 'Enroll in benefits', 'Choose a plan and coverage level below.'),
    choice('waive', 'Decline benefits', 'Waive coverage for this plan year.'));
  function choice(value, title, sub) {
    const input = el('input', { type: 'radio', name: 'decision', value });
    input.addEventListener('change', () => { state.decision = value; refresh(); });
    return el('label', {}, input, el('div', {}, el('strong', {}, title), el('span', {}, sub)));
  }

  // --- plans (current enrollment = yellow, paycheck redirection = blue)
  const plans = el('div', { class: 'plans' });
  t.planGroups.forEach((g, gi) => {
    const group = el('div', { class: 'plan-group' }, el('h3', {}, g.heading));
    g.options.forEach((o) => {
      const opt = el('div', { class: 'plan-option' },
        el('p', { class: 'opt-name' }, o.name),
        el('div', { class: 'tier-head', 'aria-hidden': 'true' }, el('div', {}, 'Coverage'), el('div', {}, 'Current enrollment'), el('div', {}, 'Paycheck redirection')));
      o.tiers.forEach((tr) => {
        const key = tierKey(tr.column);
        const cur = (emp.current || {})[key] || '';
        const input = el('input', { type: 'radio', name: `group-${gi}`, value: key, 'aria-label': `${o.name}, ${tr.label}` });
        input.addEventListener('change', () => { state.selections.set(gi, key); refresh(); });
        input.addEventListener('click', () => {
          // Allow un-selecting a plan section by clicking the chosen tier again.
          if (input.dataset.was === '1') { input.checked = false; state.selections.delete(gi); refresh(); }
        });
        input.addEventListener('pointerdown', () => { input.dataset.was = input.checked ? '1' : '0'; });
        input.addEventListener('keydown', () => { input.dataset.was = '0'; });
        opt.append(el('div', { class: 'tier' },
          el('div', {}, tr.label),
          el('div', { class: `cur hl-yellow${cur ? '' : ' empty'}`, title: 'Current enrollment' }, cur || '—'),
          el('label', { class: 'pick' }, input, 'Select')));
      });
      if (o.note) opt.append(el('p', { class: 'opt-note' }, o.note));
      group.append(opt);
    });
    plans.append(group);
  });

  // --- enrollment text + waiver
  const enrollSection = el('section', {},
    el('h2', {}, t.enrollmentHeading),
    t.enrollmentText ? rich('p', fillPlaceholders(t.enrollmentText, t)) : '',
    t.irrevocableText ? rich('p', fillPlaceholders(t.irrevocableText, t)) : '');

  const reasons = el('div', { class: 'reasons' }, ...t.waiverReasons.map((r) => {
    const cb = el('input', { type: 'checkbox', value: r });
    cb.addEventListener('change', () => { cb.checked ? state.reasons.add(r) : state.reasons.delete(r); refresh(); });
    return el('label', { class: 'hl-blue' }, cb, r);
  }));
  const waiveSection = el('section', {},
    el('h2', {}, t.waiverHeading),
    t.waiverText ? rich('p', fillPlaceholders(t.waiverText, t)) : '',
    t.waiverReasons.length ? el('fieldset', { style: 'border:0;padding:0;margin:0' }, el('legend', { class: 'label', style: 'font-weight:700' }, 'Reasons for declining (check all that apply)'), reasons) : '');

  // --- signature (blue) + date (auto)
  const canvas = el('canvas', { class: 'sigpad hl-blue', 'aria-label': 'Signature pad. Sign with your finger or mouse.', role: 'img' });
  const placeholder = el('div', { class: 'placeholder' }, 'Sign here with your finger or mouse');
  const dateValue = el('div', { class: 'value hl-yellow' }, '');
  const clearBtn = el('button', { type: 'button', class: 'btn btn-quiet' }, 'Clear');
  const consent = el('input', { type: 'checkbox', id: 'consent' });
  consent.addEventListener('change', () => refresh());
  correction.addEventListener('input', () => refresh());
  const pad = new SignaturePad(canvas, {
    onChange(hasInk) {
      placeholder.hidden = hasInk;
      refresh();
      dateValue.textContent = hasInk ? new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '';
    },
  });
  clearBtn.addEventListener('click', () => pad.clear());
  const signBlock = el('section', { class: 'sign-block' },
    el('h2', { id: 'signHeading' }, 'Sign your agreement'),
    el('div', { class: 'sign-row' },
      el('div', {}, el('div', { class: 'sigpad-wrap' }, canvas, placeholder), el('div', { class: 'sig-under' }, el('span', {}, 'Employee signature'), clearBtn)),
      el('div', { class: 'datebox' }, dateValue, el('div', { class: 'sig-under' }, el('span', {}, 'Date')))),
    el('label', { class: 'consent', for: 'consent' }, consent,
      el('span', {}, 'I agree to sign this agreement electronically, and that my electronic signature is the same as my handwritten signature.')));

  const submitBtn = el('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign and submit');
  const form = el('form', { novalidate: true, class: 'sheet' },
    el('div', { class: 'sheet-head' },
      el('p', { class: 'company' }, t.companyName),
      el('h1', {}, t.title),
      t.subtitle ? el('p', { class: 'subtitle' }, t.subtitle) : ''),
    el('div', { class: 'legend', 'aria-hidden': 'true' },
      el('span', {}, el('i', { class: 'y' }), 'From your records'),
      el('span', {}, el('i', { class: 'b' }), 'You fill in')),
    details,
    t.intro ? rich('p', fillPlaceholders(t.intro, t)) : '',
    el('h2', {}, 'Your choice'),
    decisionBox,
    plans,
    enrollSection,
    waiveSection,
    signBlock,
    alertBox,
    el('div', { class: 'actions' }, submitBtn, el('span', { class: 'small' }, 'You can’t change this agreement after you submit it.')),
    t.formDate ? el('p', { class: 'small', style: 'margin-top:18px;text-align:right' }, t.formDate) : '');

  function refresh() {
    if (!alertBox.hidden && alertBox.classList.contains('stale-ok')) alertBox.hidden = true;
    plans.classList.toggle('section-off', state.decision === 'waive');
    enrollSection.classList.toggle('section-off', state.decision === 'waive');
    waiveSection.classList.toggle('section-off', state.decision === 'enroll');
    plans.querySelectorAll('input').forEach((i) => { i.disabled = state.decision === 'waive'; });
    reasons.querySelectorAll('input').forEach((i) => { i.disabled = state.decision === 'enroll'; });
    // Picking a plan implies enrolling; checking a reason implies declining.
    if (!state.decision && state.selections.size) setDecision('enroll');
    if (!state.decision && state.reasons.size) setDecision('waive');
    document.getElementById('signHeading').textContent = state.decision === 'waive' ? 'Sign to decline benefits' : state.decision === 'enroll' ? 'Sign to enroll' : 'Sign your agreement';
  }
  function setDecision(v) {
    state.decision = v;
    decisionBox.querySelector(`input[value="${v}"]`).checked = true;
    refresh();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.hidden = true;
    const problems = [];
    if (!state.decision) problems.push('Choose whether you are enrolling or declining benefits.');
    if (state.decision === 'enroll' && !state.selections.size) problems.push('Select a plan and coverage level in the Paycheck redirection column.');
    if (state.decision === 'waive' && t.waiverReasons.length && !state.reasons.size) problems.push('Check at least one reason for declining.');
    if (!pad.hasInk()) problems.push('Sign in the signature box.');
    if (!consent.checked) problems.push('Check the box agreeing to sign electronically.');
    if (problems.length) {
      alertBox.className = 'alert stale-ok';
      alertBox.replaceChildren(el('strong', {}, 'Before you submit:'), el('ul', {}, ...problems.map((p) => el('li', {}, p))));
      alertBox.hidden = false;
      alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (isPreview) {
      alertBox.className = 'alert info';
      alertBox.textContent = 'Preview: everything is filled in correctly. In the live form this would submit.';
      alertBox.hidden = false;
      return;
    }
    busy(submitBtn, true, 'Submitting…');
    try {
      const res = await api('/api/submit', {
        method: 'POST',
        body: {
          token: session.token,
          decision: state.decision,
          selections: state.decision === 'enroll' ? [...state.selections.values()] : [],
          waiverReasons: state.decision === 'waive' ? [...state.reasons] : [],
          correctionAddress: correction.value,
          signature: pad.toPNG(),
          consent: true,
        },
      });
      doneScreen(res, state.decision);
    } catch (err) {
      if (err.data?.restart) return verifyScreen(err.message);
      alertBox.className = 'alert';
      alertBox.textContent = err.message;
      alertBox.hidden = false;
      busy(submitBtn, false, 'Sign and submit');
    }
  });

  screen(form);
  refresh();
  requestAnimationFrame(() => pad.resize());
}

// ---------------- Step 3: done ----------------
function doneScreen(res, decision) {
  dirty = false;
  clearTimeout(expiryTimer);
  session = null;
  const check = el('div', { class: 'check', 'aria-hidden': 'true' });
  check.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  screen(el('div', { class: 'sheet verify done' },
    check,
    el('h1', {}, 'Your agreement is signed'),
    el('p', {}, decision === 'enroll' ? 'Your benefit election was submitted to AWA Insurance.' : 'Your decision to decline benefits was submitted to AWA Insurance.'),
    el('p', {}, 'Confirmation number', el('br'), el('span', { class: 'code' }, res.confirmation)),
    el('p', { class: 'small' }, 'Write this number down if you’d like a record. You can close this page now.')));
  history.replaceState(null, '', location.pathname);
}

// ---------------- boot ----------------
async function boot() {
  if (isPreview) {
    document.getElementById('previewBanner').hidden = false;
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || e.data?.type !== 'awa-preview') return;
      template = e.data.template;
      setCompany(template);
      session = { token: 'preview', expiresAt: Date.now() + 3_600_000, employee: e.data.employee };
      formScreen();
    });
    if (window.opener) window.opener.postMessage({ type: 'awa-preview-ready' }, location.origin);
    else errorScreen('Open the preview from the admin page.');
    return;
  }
  if (!slug) return errorScreen('This page needs the link from your employer’s QR code.');
  try {
    const res = await api(`/api/company/${encodeURIComponent(slug)}`);
    template = res.template;
    setCompany(template);
    verifyScreen();
  } catch (err) {
    errorScreen(err.message);
  }
}
boot();
