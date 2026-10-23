// Per-company form templates.
//
// Every company's agreement is described by a template. The wording, plans, tiers and waiver
// reasons change from company to company; what never changes is the data flow:
//   YELLOW (prefilled from the Current Redirection sheet): employee name, current home address,
//          and the current-enrollment value for every plan tier.
//   BLUE   (collected from the employee and written to the Open Enrollment Redirection sheet):
//          home address correction, the paycheck-redirection tier selections OR waiver reasons,
//          and the signature + signed date.

export const IDENTITY_COLUMNS = {
  name: { header: 'Name ', aliases: ['name', 'employeename', 'employee', 'fullname'] },
  dob: { header: 'Date of Birth', aliases: ['dateofbirth', 'dob', 'birthdate', 'birthday'] },
  ssn: { header: 'SS#', aliases: ['ss', 'ssn', 'ssno', 'socialsecurity', 'socialsecuritynumber', 'social'] },
  address: { header: 'Current Address', aliases: ['currentaddress', 'address', 'homeaddress', 'currenthomeaddress'] },
};

export const EXPORT_IDENTITY_HEADERS = ['Name ', 'Date of Birth', 'SS#', 'Correction Address'];

export const normalizeHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function defaultTemplate() {
  return {
    slug: '',
    companyName: 'ABC Company, Inc.',
    notifyEmail: '',
    active: true,
    title: 'Plan Benefits Election and Compensation Redirection Agreement Form',
    subtitle: '(52 Pay Periods – Weekly Paycheck Deductions)',
    intro:
      'On the benefit applications and enrollment cards, I have applied for certain eligible coverages under the Flexible Benefits Plan of {{company}}. With the understanding that this will reduce my FICA (Social Security) contributions, it is my decision to receive the following benefits.',
    planGroups: [
      {
        heading: 'Florida Blue - Medical Plan(s)',
        options: [
          {
            name: 'Option 1: BlueCare 14256',
            note: 'See Deduction Worksheet Attached',
            tiers: [
              { label: 'Employee', column: 'FB 1 EE' },
              { label: 'Employee & Spouse', column: 'FB 1 ES' },
              { label: 'Employee & Child(ren)', column: 'FB 1 EC' },
              { label: 'Family', column: 'FB 1 FM' },
            ],
          },
          {
            name: 'Option 2: SimplyBlue 18904',
            note: 'See Deduction Worksheet Attached',
            tiers: [
              { label: 'Employee', column: 'FB 2 EE' },
              { label: 'Employee & Spouse', column: 'FB 2 ES' },
              { label: 'Employee & Child(ren)', column: 'FB 2 EC' },
              { label: 'Family', column: 'FB 2 FM' },
            ],
          },
        ],
      },
    ],
    startDate: '',
    anniversaryDate: '03/01/2027',
    enrollmentHeading: 'Enrolling in Benefits',
    enrollmentText:
      '{{company}} and I agree that beginning {{startDate}} and continuing each pay period thereafter until this agreement is amended or terminated, my salary will be reduced by the amount of my required contributions for the benefits I have elected under this plan. The amount of my required contribution for each benefit selected is as set forth on the above schedule.',
    irrevocableText:
      'I understand that this agreement is irrevocable and **cannot** be changed or modified until the next Plan Anniversary Date {{anniversaryDate}}. Further, any previous compensation authorization agreement under the Plan relating to the same benefits offered herein is revoked.',
    waiverHeading: 'Waiver/Declining Benefits',
    waiverText:
      "{{company}} has offered the above benefits and I have decided I do not want to participate in my group's Cafeteria Plan for this Plan Year.",
    waiverReasons: ['Covered under Parent(s)', 'Covered under Spouse', 'Tricare', 'Medicaid', 'Medicare', 'Individual Policy', 'Do not want'],
    formDate: '01/01/2027',
  };
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(v, max, field, errors, { required = false } = {}) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (required && !s) errors.push(`${field} is required.`);
  if (s.length > max) errors.push(`${field} is too long (max ${max} characters).`);
  return s.slice(0, max);
}

/** Validate and normalize a template coming from the admin editor. Returns { template, errors }. */
export function cleanTemplate(input) {
  const errors = [];
  const t = input && typeof input === 'object' ? input : {};
  const out = {};
  out.slug = str(t.slug, 40, 'Link name', errors, { required: true }).toLowerCase();
  if (out.slug && !SLUG_RE.test(out.slug)) errors.push('Link name may only use lowercase letters, numbers and dashes.');
  out.companyName = str(t.companyName, 120, 'Company name', errors, { required: true });
  out.notifyEmail = str(t.notifyEmail, 300, 'Notification email', errors);
  if (out.notifyEmail) {
    const list = out.notifyEmail.split(/[,;]\s*/).filter(Boolean);
    if (list.some((e) => !EMAIL_RE.test(e))) errors.push('Notification email must be one or more valid email addresses, separated by commas.');
    out.notifyEmail = list.join(', ');
  }
  out.active = t.active !== false;
  out.title = str(t.title, 200, 'Form title', errors, { required: true });
  out.subtitle = str(t.subtitle, 200, 'Subtitle', errors);
  out.intro = str(t.intro, 3000, 'Intro paragraph', errors);
  out.startDate = str(t.startDate, 40, 'Start date', errors);
  out.anniversaryDate = str(t.anniversaryDate, 40, 'Plan anniversary date', errors);
  out.enrollmentHeading = str(t.enrollmentHeading, 120, 'Enrollment heading', errors) || 'Enrolling in Benefits';
  out.enrollmentText = str(t.enrollmentText, 3000, 'Enrollment text', errors);
  out.irrevocableText = str(t.irrevocableText, 3000, 'Irrevocable text', errors);
  out.waiverHeading = str(t.waiverHeading, 120, 'Waiver heading', errors) || 'Waiver/Declining Benefits';
  out.waiverText = str(t.waiverText, 3000, 'Waiver text', errors);
  out.formDate = str(t.formDate, 40, 'Form date', errors);

  const reasons = Array.isArray(t.waiverReasons) ? t.waiverReasons : [];
  out.waiverReasons = reasons.map((r, i) => str(r, 80, `Waiver reason ${i + 1}`, errors)).filter(Boolean);
  if (out.waiverReasons.length > 20) errors.push('No more than 20 waiver reasons.');

  const groups = Array.isArray(t.planGroups) ? t.planGroups : [];
  if (!groups.length) errors.push('Add at least one plan section.');
  if (groups.length > 10) errors.push('No more than 10 plan sections.');
  const seenColumns = new Map();
  const identityNorms = new Set(Object.values(IDENTITY_COLUMNS).flatMap((c) => c.aliases).concat(['correctionaddress', 'status', 'waiverreasons', 'signeddate']));
  out.planGroups = groups.slice(0, 10).map((g, gi) => {
    const group = { heading: str(g?.heading, 160, `Plan section ${gi + 1} heading`, errors, { required: true }) };
    const options = Array.isArray(g?.options) ? g.options : [];
    if (!options.length) errors.push(`Plan section ${gi + 1} needs at least one plan option.`);
    group.options = options.slice(0, 10).map((o, oi) => {
      const where = `Section ${gi + 1}, option ${oi + 1}`;
      const option = {
        name: str(o?.name, 160, `${where} name`, errors, { required: true }),
        note: str(o?.note, 200, `${where} note`, errors),
      };
      const tiers = Array.isArray(o?.tiers) ? o.tiers : [];
      if (!tiers.length) errors.push(`${where} needs at least one coverage tier.`);
      option.tiers = tiers.slice(0, 12).map((tr, ti) => {
        const label = str(tr?.label, 80, `${where}, tier ${ti + 1} label`, errors, { required: true });
        const column = str(tr?.column, 60, `${where}, tier ${ti + 1} spreadsheet column`, errors, { required: true });
        const norm = normalizeHeader(column);
        if (column && !norm) errors.push(`${where}, tier ${ti + 1}: spreadsheet column needs letters or numbers.`);
        if (norm && identityNorms.has(norm)) errors.push(`Spreadsheet column "${column}" is reserved for employee details.`);
        if (norm && seenColumns.has(norm)) errors.push(`Spreadsheet column "${column}" is used for more than one tier.`);
        seenColumns.set(norm, true);
        return { label, column };
      });
      return option;
    });
    return group;
  });
  return { template: out, errors };
}

/** All tiers in display order, with a stable key (the normalized column name). */
export function allTiers(template) {
  const out = [];
  template.planGroups.forEach((g, gi) => g.options.forEach((o, oi) => o.tiers.forEach((t) => {
    out.push({ ...t, key: normalizeHeader(t.column), groupIndex: gi, optionName: o.name, groupHeading: g.heading });
  })));
  return out;
}

/** Fill {{company}}, {{startDate}}, {{anniversaryDate}} placeholders (plain text, no HTML). */
export function fillPlaceholders(text, template) {
  const company = template.companyName || '';
  return String(text || '')
    // Avoid "Inc.." when the company name already ends with a period.
    .replace(/\{\{\s*company\s*\}\}(\.?)/gi, (_, dot) => (company.endsWith('.') ? company : company + dot))
    .replace(/\{\{\s*startDate\s*\}\}/gi, template.startDate || '________')
    .replace(/\{\{\s*anniversaryDate\s*\}\}/gi, template.anniversaryDate || '________');
}

/** Fields the employee page needs (no admin-only settings like notification emails). */
export function publicTemplate(t) {
  const { notifyEmail, ...rest } = t;
  return rest;
}
