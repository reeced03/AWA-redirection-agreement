// Minimal, dependency-light .xlsx reader and writer (built on JSZip).
// Reads the first worksheet into rows of cell values; writes a single formatted worksheet.
import JSZip from 'jszip';

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&(lt|gt|amp|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

function escapeXml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function textOf(xmlFragment) {
  // Concatenate every <t>…</t> run (handles rich text in shared strings)
  const parts = [];
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(xmlFragment))) parts.push(m[1] ? decodeXml(m[1]) : '');
  return parts.join('');
}

function colToIndex(ref) {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(i) {
  let s = '';
  i += 1;
  while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** Read the first worksheet. Returns an array of rows; each row an array of values (string | number | boolean | null). */
export async function readFirstSheet(bytes) {
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new Error('This file is not a valid .xlsx workbook.'); }
  const wb = await zip.file('xl/workbook.xml')?.async('string');
  if (!wb) throw new Error('This file is not a valid .xlsx workbook.');
  const firstSheet = /<(?:\w+:)?sheet\b[^>]*\br:id="([^"]+)"/.exec(wb) || /<(?:\w+:)?sheet\b[^>]*\bid="([^"]+)"/.exec(wb);
  const rels = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) || '';
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (firstSheet) {
    const relRe = new RegExp(`<Relationship\\b[^>]*\\bId="${firstSheet[1]}"[^>]*>`);
    const rel = relRe.exec(rels);
    const target = rel && /Target="([^"]+)"/.exec(rel[0]);
    if (target) sheetPath = resolvePath('xl/workbook.xml', target[1]);
  }
  const sheetXml = await zip.file(sheetPath)?.async('string');
  if (!sheetXml) throw new Error('Could not find the first worksheet in this workbook.');

  const sstXml = (await zip.file('xl/sharedStrings.xml')?.async('string')) || '';
  const shared = [];
  const siRe = /<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let m;
  while ((m = siRe.exec(sstXml))) shared.push(textOf(m[1]));

  const rows = [];
  const rowRe = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g;
  while ((m = rowRe.exec(sheetXml))) {
    const rAttr = /\br="(\d+)"/.exec(m[1]);
    const rowIndex = rAttr ? Number(rAttr[1]) - 1 : rows.length;
    const row = [];
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let c;
    let nextCol = 0;
    while ((c = cellRe.exec(m[2]))) {
      const attrs = c[1];
      const inner = c[2] || '';
      const ref = /\br="([A-Z]+\d+)"/i.exec(attrs);
      const col = ref ? colToIndex(ref[1]) : nextCol;
      nextCol = col + 1;
      const type = (/\bt="(\w+)"/.exec(attrs) || [])[1] || 'n';
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
      let value = null;
      if (type === 's') value = v ? (shared[Number(v[1])] ?? '') : '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str' || type === 'e') value = v ? decodeXml(v[1]) : '';
      else if (type === 'b') value = v ? v[1] === '1' : null;
      else if (v) { const num = Number(v[1]); value = Number.isFinite(num) ? num : decodeXml(v[1]); }
      row[col] = value;
    }
    rows[rowIndex] = row;
  }
  return rows.map((r) => (r ? Array.from(r, (x) => (x === undefined ? null : x)) : []));
}

/** Excel serial date → ISO yyyy-mm-dd (1900 date system). */
export function serialToISO(serial) {
  const ms = Math.round((Number(serial) - 25569) * 86400000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

export function isoToSerial(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  return Date.UTC(y, mo - 1, d) / 86400000 + 25569;
}

/**
 * Write a single-sheet workbook.
 * columns: [{ header, width?, type?: 'text' | 'date' | 'auto' }]
 * rows: arrays of values aligned with columns. Date columns take ISO yyyy-mm-dd strings.
 */
export async function writeSheet({ sheetName = 'Sheet1', columns, rows }) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>AWA Insurance</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>AWA Redirection Agreement</Application></Properties>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(sheetName.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  // Styles: 0 default, 1 bold header, 2 date mm/dd/yyyy, 3 text (@), 4 centered
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="mm/dd/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);

  const strCell = (ref, s, style = 0) => `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${escapeXml(s)}</t></is></c>`;
  const lines = [];
  lines.push(`<row r="1">${columns.map((c, i) => strCell(`${indexToCol(i)}1`, c.header, 1)).join('')}</row>`);
  rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells = [];
    columns.forEach((col, ci) => {
      const v = row[ci];
      if (v === null || v === undefined || v === '') return;
      const ref = `${indexToCol(ci)}${r}`;
      if (col.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v))) cells.push(`<c r="${ref}" s="2"><v>${isoToSerial(String(v))}</v></c>`);
      else if (col.type === 'text') cells.push(strCell(ref, v, 3));
      else if (col.type === 'center') cells.push(strCell(ref, v, 4));
      else if (typeof v === 'number') cells.push(`<c r="${ref}"><v>${v}</v></c>`);
      else cells.push(strCell(ref, v));
    });
    lines.push(`<row r="${r}">${cells.join('')}</row>`);
  });
  const colsXml = `<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>`;
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${colsXml}<sheetData>${lines.join('')}</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
