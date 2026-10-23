// Parse a company's "Current Redirection" spreadsheet into employee records,
// and build the "Open Enrollment Redirection" export.
import { readFirstSheet, serialToISO, writeSheet } from './xlsx.mjs';
import { IDENTITY_COLUMNS, EXPORT_IDENTITY_HEADERS, normalizeHeader, allTiers } from './template.mjs';
import { employeeId } from './crypto.mjs';

export function normalizeSSN(v) {
  if (v === null || v === undefined) return '';
  const digits = (typeof v === 'number' ? String(Math.round(v)) : String(v)).replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length > 9) return '';
  return digits.padStart(9, '0');
}

export function normalizeDOB(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v > 0 && v < 80000 ? serialToISO(v) : '';
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y > new Date().getFullYear() % 100 ? 1900 : 2000;
    return iso(y, +m[1], +m[2]);
  }
  if (/^\d+(\.\d+)?$/.test(s)) return normalizeDOB(Number(s));
  return '';
}

function iso(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return dt.toISOString().slice(0, 10);
}

const display = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v).trim();
};

/**
 * Parse uploaded Current Redirection workbook.
 * Returns { employees, report } where report lists matched / missing columns and skipped rows.
 */
export async function parseRoster(bytes, template, secret) {
  const rows = await readFirstSheet(bytes);
  // Header row = first row that contains a name column and an SSN column.
  let headerRow = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const norms = (rows[i] || []).map(normalizeHeader);
    if (norms.some((n) => IDENTITY_COLUMNS.name.aliases.includes(n)) && norms.some((n) => IDENTITY_COLUMNS.ssn.aliases.includes(n))) { headerRow = i; break; }
  }
  if (headerRow < 0) throw new Error('Could not find the header row. The sheet needs "Name", "Date of Birth", "SS#" and "Current Address" columns.');
  const headers = rows[headerRow].map((h) => display(h));
  const norms = headers.map(normalizeHeader);
  const findCol = (aliases) => norms.findIndex((n) => aliases.includes(n));

  const idx = {};
  const missing = [];
  for (const [field, def] of Object.entries(IDENTITY_COLUMNS)) {
    idx[field] = findCol(def.aliases);
    if (idx[field] < 0) missing.push(def.header.trim());
  }
  if (idx.name < 0 || idx.ssn < 0 || idx.dob < 0) {
    throw new Error(`Missing required column(s): ${missing.join(', ')}.`);
  }

  const tiers = allTiers(template);
  const tierIdx = {};
  const missingTierColumns = [];
  for (const t of tiers) {
    const i = norms.indexOf(t.key);
    tierIdx[t.key] = i;
    if (i < 0) missingTierColumns.push(t.column);
  }
  const knownCols = new Set([...Object.values(idx), ...Object.values(tierIdx)].filter((i) => i >= 0));
  const extraColumns = headers.filter((h, i) => h && !knownCols.has(i));

  const employees = [];
  const skipped = [];
  const seenKeys = new Map();
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (!row.some((v) => v !== null && v !== '')) continue;
    const name = display(row[idx.name]);
    const ssn = normalizeSSN(row[idx.ssn]);
    const dob = normalizeDOB(row[idx.dob]);
    const rowNo = r + 1;
    if (!name && !ssn) continue;
    if (!name) { skipped.push({ row: rowNo, reason: 'missing name' }); continue; }
    if (!ssn) { skipped.push({ row: rowNo, name, reason: 'missing or invalid SS#' }); continue; }
    if (!dob) { skipped.push({ row: rowNo, name, reason: 'missing or invalid date of birth' }); continue; }
    const current = {};
    for (const t of tiers) current[t.key] = tierIdx[t.key] >= 0 ? display(row[tierIdx[t.key]]) : '';
    const emp = {
      id: employeeId(secret, template.slug, ssn, dob),
      name,
      dob,
      ssn,
      address: idx.address >= 0 ? display(row[idx.address]) : '',
      current,
      row: rowNo,
    };
    const loginKey = `${ssn.slice(-4)}|${dob}`;
    if (seenKeys.has(loginKey)) emp.loginConflict = true, (seenKeys.get(loginKey).loginConflict = true);
    seenKeys.set(loginKey, emp);
    employees.push(emp);
  }

  return {
    employees,
    report: {
      employeeCount: employees.length,
      missingColumns: missing,
      missingTierColumns,
      extraColumns,
      skipped,
      loginConflicts: employees.filter((e) => e.loginConflict).map((e) => ({ row: e.row, name: e.name })),
    },
  };
}

/** Build the Open Enrollment Redirection workbook for one company. */
export async function buildExport(template, employees, submissions) {
  const tiers = allTiers(template);
  const columns = [
    { header: EXPORT_IDENTITY_HEADERS[0], width: 26 },
    { header: EXPORT_IDENTITY_HEADERS[1], width: 14, type: 'date' },
    { header: EXPORT_IDENTITY_HEADERS[2], width: 13, type: 'text' },
    { header: EXPORT_IDENTITY_HEADERS[3], width: 40 },
    ...tiers.map((t) => ({ header: t.column, width: Math.max(9, t.column.length + 2), type: 'center' })),
    { header: 'Status', width: 14 },
    { header: 'Waiver Reasons', width: 34 },
    { header: 'Signed Date', width: 14, type: 'date' },
  ];
  const byId = new Map(submissions.map((s) => [s.employeeId, s]));
  const rows = [];
  const rowFor = (person, sub) => [
    person.name,
    person.dob,
    person.ssn,
    sub?.correctionAddress || '',
    ...tiers.map((t) => (sub?.decision === 'enroll' && sub.selections?.includes(t.key) ? 'X' : '')),
    sub ? (sub.decision === 'enroll' ? 'Enrolled' : 'Waived') : 'Not submitted',
    sub?.decision === 'waive' ? (sub.waiverReasons || []).join('; ') : '',
    sub ? sub.signedAt.slice(0, 10) : '',
  ];
  for (const e of employees) {
    rows.push(rowFor(e, byId.get(e.id)));
    byId.delete(e.id);
  }
  // Submissions from employees no longer on the current roster still get exported.
  for (const sub of byId.values()) rows.push(rowFor(sub.employee, sub));
  return writeSheet({ sheetName: 'Open Enrollment Redirection', columns, rows });
}
