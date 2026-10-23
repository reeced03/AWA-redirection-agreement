// Render a signed agreement as a PDF that mirrors the paper form.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { fillPlaceholders } from './template.mjs';
import { normalizeHeader } from './template.mjs';

const RED = rgb(0xdf / 255, 0x30 / 255, 0x33 / 255);
const INK = rgb(0.15, 0.15, 0.15);
const MUTED = rgb(0.42, 0.42, 0.42);
const LINE = rgb(0.75, 0.75, 0.75);
const YELLOW = rgb(1, 0.965, 0.8);
const BLUE = rgb(0.9, 0.95, 0.985);

// pdf-lib standard fonts only cover WinAnsi; replace anything else so rendering never throws.
function winAnsi(s) {
  return String(s ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/…/g, '...').replace(/[ ]/g, ' ')
    .replace(/[^\x20-\x7E¡-ÿ–—€]/g, '');
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${m}/${d}/${y}`;
}

export async function renderAgreementPdf({ template, submission }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`${template.title} - ${submission.employee.name}`);
  doc.setAuthor('AWA Insurance');
  doc.setSubject(`${template.companyName} redirection agreement`);
  doc.setCreationDate(new Date(submission.signedAt));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const W = 612, H = 792, M = 50;
  let page = doc.addPage([W, H]);
  let y = H - M;

  const ensure = (h) => { if (y - h < M + 30) { page = doc.addPage([W, H]); y = H - M; } };
  const footer = () => {
    page.drawText(winAnsi(`${template.companyName}  |  ${template.formDate || ''}`), { x: M, y: 28, size: 8, font, color: MUTED });
    page.drawText(winAnsi(`Confirmation ${submission.confirmation}`), { x: W - M - font.widthOfTextAtSize(`Confirmation ${submission.confirmation}`, 8), y: 28, size: 8, font, color: MUTED });
  };

  function wrap(text, f, size, width) {
    const words = winAnsi(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(next, size) <= width || !cur) cur = next; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  // Supports **bold** runs inside a paragraph.
  function paragraph(text, { size = 10, width = W - 2 * M, x = M, gap = 6 } = {}) {
    const filled = fillPlaceholders(text, template);
    const tokens = [];
    filled.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
      const isBold = /^\*\*[^*]+\*\*$/.test(part);
      const clean = isBold ? part.slice(2, -2) : part;
      clean.split(/(\s+)/).forEach((w) => { if (w) tokens.push({ w: winAnsi(w), f: isBold ? bold : font }); });
    });
    const lineH = size * 1.35;
    let line = [];
    let lineW = 0;
    const flush = () => {
      ensure(lineH);
      let cx = x;
      // trim trailing whitespace tokens
      while (line.length && !line[line.length - 1].w.trim()) line.pop();
      for (const t of line) { page.drawText(t.w, { x: cx, y: y - size, size, font: t.f, color: INK }); cx += t.f.widthOfTextAtSize(t.w, size); }
      y -= lineH;
      line = []; lineW = 0;
    };
    for (const t of tokens) {
      const tw = t.f.widthOfTextAtSize(t.w, size);
      if (!t.w.trim() && !line.length) continue;
      if (lineW + tw > width && line.length) { flush(); if (!t.w.trim()) continue; }
      line.push(t); lineW += tw;
    }
    if (line.length) flush();
    y -= gap;
  }

  function heading(text, size = 11) {
    ensure(size + 10);
    page.drawText(winAnsi(text), { x: M, y: y - size, size, font: bold, color: INK });
    y -= size + 8;
  }

  function field(label, value, x, width, fill) {
    const labelW = bold.widthOfTextAtSize(winAnsi(label), 9) + 6;
    const lines = wrap(value || ' ', font, 10, width - labelW - 6);
    const h = Math.max(18, lines.length * 13 + 6);
    page.drawRectangle({ x: x + labelW, y: y - h, width: width - labelW, height: h, color: fill, borderColor: LINE, borderWidth: 0.5 });
    page.drawText(winAnsi(label), { x, y: y - 12, size: 9, font: bold, color: INK });
    lines.forEach((ln, i) => page.drawText(ln, { x: x + labelW + 4, y: y - 13 - i * 13, size: 10, font, color: INK }));
    return h;
  }

  // ---- Header ----
  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: RED });
  const company = winAnsi(template.companyName);
  page.drawText(company, { x: (W - bold.widthOfTextAtSize(company, 14)) / 2, y: y - 14, size: 14, font: bold, color: INK });
  y -= 24;
  for (const ln of wrap(template.title.toUpperCase(), bold, 11, W - 2 * M)) {
    page.drawText(ln, { x: (W - bold.widthOfTextAtSize(ln, 11)) / 2, y: y - 11, size: 11, font: bold, color: INK });
    y -= 15;
  }
  if (template.subtitle) {
    const st = winAnsi(template.subtitle);
    page.drawText(st, { x: (W - font.widthOfTextAtSize(st, 10)) / 2, y: y - 10, size: 10, font, color: INK });
    y -= 16;
  }
  y -= 6;

  // ---- Employee details ----
  const emp = submission.employee;
  let h = field('Employee Name:', emp.name, M, W - 2 * M, YELLOW); y -= h + 5;
  h = field('Current Home Address:', emp.address, M, W - 2 * M, YELLOW); y -= h + 5;
  h = field('Home Address Correction:', submission.correctionAddress || '', M, W - 2 * M, BLUE); y -= h + 12;

  paragraph(template.intro);

  // ---- Plan table ----
  const colCur = W - M - 190, colRed = W - M - 95;
  const isEnroll = submission.decision === 'enroll';
  const selected = new Set(isEnroll ? submission.selections : []);
  ensure(30);
  page.drawText('Current', { x: colCur + 18, y: y - 9, size: 9, font: bold, color: INK });
  page.drawText('Enrollment', { x: colCur + 10, y: y - 20, size: 9, font: bold, color: INK });
  page.drawText('Paycheck', { x: colRed + 16, y: y - 9, size: 9, font: bold, color: INK });
  page.drawText('Redirection', { x: colRed + 10, y: y - 20, size: 9, font: bold, color: INK });
  y -= 28;
  for (const g of template.planGroups) {
    ensure(20);
    page.drawText(winAnsi(g.heading), { x: M, y: y - 11, size: 11, font: bold, color: INK });
    y -= 18;
    for (const o of g.options) {
      ensure(18);
      page.drawText(winAnsi(o.name), { x: M + 14, y: y - 10, size: 10, font: bold, color: INK });
      y -= 16;
      for (const t of o.tiers) {
        ensure(17);
        const key = normalizeHeader(t.column);
        page.drawText(winAnsi(t.label), { x: M + 34, y: y - 10, size: 10, font, color: INK });
        const cur = emp.current?.[key] || '';
        page.drawRectangle({ x: colCur, y: y - 14, width: 80, height: 15, color: YELLOW, borderColor: LINE, borderWidth: 0.5 });
        if (cur) page.drawText(winAnsi(cur).slice(0, 14), { x: colCur + 4, y: y - 10.5, size: 9, font, color: INK });
        page.drawRectangle({ x: colRed, y: y - 14, width: 80, height: 15, color: BLUE, borderColor: LINE, borderWidth: 0.5 });
        if (selected.has(key)) page.drawText('X  Selected', { x: colRed + 6, y: y - 10.5, size: 9, font: bold, color: INK });
        y -= 18;
      }
      if (o.note) {
        ensure(14);
        const note = winAnsi(o.note);
        page.drawText(note, { x: W - M - italic.widthOfTextAtSize(note, 8.5), y: y - 8, size: 8.5, font: italic, color: MUTED });
        y -= 14;
      }
      y -= 4;
    }
  }
  y -= 6;

  const sigBlock = async (active) => {
    ensure(70);
    const top = y;
    page.drawLine({ start: { x: M, y: top - 50 }, end: { x: M + 300, y: top - 50 }, thickness: 0.8, color: INK });
    page.drawLine({ start: { x: W - M - 150, y: top - 50 }, end: { x: W - M, y: top - 50 }, thickness: 0.8, color: INK });
    if (active) {
      const png = await doc.embedPng(Buffer.from(submission.signature.split(',')[1], 'base64'));
      const scale = Math.min(290 / png.width, 46 / png.height);
      page.drawImage(png, { x: M + 4, y: top - 49, width: png.width * scale, height: png.height * scale });
      page.drawText(fmtDate(submission.signedAt), { x: W - M - 140, y: top - 44, size: 11, font, color: INK });
    }
    page.drawText('Employee Signature', { x: M, y: top - 62, size: 9, font, color: INK });
    page.drawText('Date', { x: W - M - 150, y: top - 62, size: 9, font, color: INK });
    y = top - 76;
  };

  // ---- Enrolling ----
  heading(`${template.enrollmentHeading}:`);
  paragraph(template.enrollmentText);
  paragraph(template.irrevocableText);
  await sigBlock(isEnroll);

  // ---- Waiver ----
  heading(`${template.waiverHeading}:`);
  paragraph(template.waiverText);
  if (template.waiverReasons.length) {
    ensure(18);
    page.drawText('Reasons for Declining:', { x: M, y: y - 10, size: 10, font: bold, color: INK });
    y -= 18;
    const chosen = new Set(isEnroll ? [] : submission.waiverReasons);
    let cx = M;
    for (const r of template.waiverReasons) {
      const label = winAnsi(r);
      const w = 14 + font.widthOfTextAtSize(label, 9.5) + 16;
      if (cx + w > W - M) { cx = M; y -= 18; ensure(18); }
      page.drawRectangle({ x: cx, y: y - 11, width: 10, height: 10, color: BLUE, borderColor: INK, borderWidth: 0.7 });
      if (chosen.has(r)) page.drawText('X', { x: cx + 2, y: y - 9.5, size: 9, font: bold, color: INK });
      page.drawText(label, { x: cx + 14, y: y - 10, size: 9.5, font, color: INK });
      cx += w;
    }
    y -= 22;
  }
  await sigBlock(!isEnroll);

  // ---- Electronic signature record ----
  ensure(70);
  y -= 4;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINE });
  y -= 12;
  const audit = [
    `Electronically signed by ${emp.name} on ${new Date(submission.signedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })} (Eastern).`,
    `Identity verified with last 4 of SSN and date of birth. Employee agreed to sign electronically.`,
    `IP address: ${submission.audit?.ip || 'unknown'}   Confirmation: ${submission.confirmation}`,
  ];
  for (const a of audit) {
    for (const ln of wrap(a, font, 8, W - 2 * M)) { ensure(11); page.drawText(ln, { x: M, y: y - 8, size: 8, font, color: MUTED }); y -= 11; }
  }

  // footers on every page
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    footer();
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: (W - font.widthOfTextAtSize(label, 8)) / 2, y: 28, size: 8, font, color: MUTED });
  });
  return doc.save();
}
