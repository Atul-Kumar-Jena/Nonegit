/**
 * Attendance downloads: the same report as a PDF (printed from HTML) or an Excel workbook
 * (.xlsx, written here — no server round-trip, so it works offline from the last copy).
 * Every file ends with the Attendly credit line.
 */
import { Platform } from 'react-native';
import { strToU8, zipSync } from 'fflate';
import type { MatrixReport, PunctualityReport, StudentReport } from '@attendly/protocol';
import { clock, pct, zoned } from './format';

export const CREDIT = 'Attendly · Created by Atul Kumar Jena';

export type Cell = string | number | null;
export interface Column {
  label: string;
  kind?: 'text' | 'int' | 'pct';
  width?: number; // Excel character width
}
export interface Section {
  heading: string;
  columns: Column[];
  rows: Cell[][];
  /** Row indexes to show in bold (totals). */
  strong?: number[];
}
export interface ExportDoc {
  filename: string;
  title: string;
  subtitle: string;
  meta: [string, string][];
  sections: Section[];
  wide?: boolean;
}

// ───────────────────────────── report → document ─────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(iso: string, tz: string): string {
  const z = zoned(iso, tz);
  return `${z.d} ${MONTHS[z.m]} ${z.y}, ${clock(iso, tz)}`;
}
const dateOnly = (iso: string, tz: string) => {
  const z = zoned(iso, tz);
  return `${z.d} ${MONTHS[z.m]} ${z.y}`;
};
const STANDING: Record<string, string> = { safe: 'OK', 'at-risk': 'Below minimum', 'no-data': 'No classes yet' };
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'report';
const stamp = (iso: string, tz: string) => {
  const z = zoned(iso, tz);
  return `${z.y}-${String(z.m + 1).padStart(2, '0')}-${String(z.d).padStart(2, '0')}`;
};

function header(r: { institution: string; termName: string; minPercent: number; generatedAt: string; timezone: string }): [string, string][] {
  return [
    ['Institution', r.institution],
    ['Term', r.termName],
    ['Minimum attendance', `${pct(r.minPercent)}%`],
    ['Data as of', when(r.generatedAt, r.timezone)],
  ];
}

export function studentReportDoc(r: StudentReport): ExportDoc {
  const one = r.classes !== null && r.subjects.length === 1;
  const subj = r.subjects[0];
  const rows: Cell[][] = r.subjects.map((s) => [s.code, s.title === s.code ? '' : s.title, s.instructor ?? '', s.attended, s.held, s.percent, STANDING[s.standing] ?? s.standing]);
  const strong: number[] = [];
  if (!one) {
    strong.push(rows.length);
    rows.push(['All subjects', 'Cumulative', '', r.total.attended, r.total.held, r.total.percent, STANDING[r.total.standing] ?? '']);
  }
  const sections: Section[] = [
    {
      heading: one ? 'Subject' : 'Per subject',
      columns: [
        { label: 'Code', width: 12 },
        { label: 'Subject', width: 30 },
        { label: 'Teacher', width: 20 },
        { label: 'Attended', kind: 'int', width: 10 },
        { label: 'Held', kind: 'int', width: 8 },
        { label: '%', kind: 'pct', width: 8 },
        { label: 'Status', width: 16 },
      ],
      rows,
      strong,
    },
  ];
  if (r.classes)
    sections.push({
      heading: 'Class by class',
      columns: [
        { label: '#', kind: 'int', width: 5 },
        { label: 'Date', width: 14 },
        { label: 'Time', width: 10 },
        { label: 'Attendance', width: 12 },
        { label: 'Marked by', width: 20 },
      ],
      rows: r.classes.map((c, i) => [i + 1, dateOnly(c.start, r.timezone), clock(c.start, r.timezone), c.status === 'present' ? 'Present' : c.status === 'live' ? 'In progress' : 'Absent', c.how ?? '']),
    });
  const who = [r.student.fullName, r.student.rollNo ? `Roll ${r.student.rollNo}` : null, r.student.batches.join(', ') || null].filter(Boolean).join(' · ');
  return {
    filename: `Attendly_${slug(r.student.rollNo ?? r.student.fullName)}_${one && subj ? `${slug(subj.code)}_` : ''}${stamp(r.generatedAt, r.timezone)}`,
    title: one && subj ? `${subj.code}${subj.title !== subj.code ? ` · ${subj.title}` : ''} — attendance` : 'Attendance report',
    subtitle: who,
    meta: [...header(r), ['Overall', `${r.total.attended} of ${r.total.held} classes · ${pct(r.total.percent)}%`]],
    sections,
  };
}

export function matrixReportDoc(r: MatrixReport): ExportDoc {
  const single = r.courses.length === 1;
  const columns: Column[] = [
    { label: 'Roll no.', width: 12 },
    { label: 'Name', width: 24 },
    ...(single ? [] : r.courses.map((c) => ({ label: `${c.code} %`, kind: 'pct' as const, width: Math.max(9, c.code.length + 3) }))),
    { label: 'Attended', kind: 'int', width: 10 },
    { label: 'Held', kind: 'int', width: 8 },
    { label: single ? '%' : 'Overall %', kind: 'pct', width: 10 },
    { label: 'Status', width: 16 },
  ];
  const rows: Cell[][] = r.students.map((s) => [
    s.rollNo ?? '',
    s.fullName,
    ...(single ? [] : s.cells.map((c) => (c ? (c.held ? Math.round((c.attended / c.held) * 1000) / 10 : null) : null))),
    s.attended,
    s.held,
    s.percent,
    STANDING[s.standing] ?? s.standing,
  ]);
  const below = r.students.filter((s) => s.standing === 'at-risk').length;
  const sections: Section[] = [{ heading: `${r.students.length} students`, columns, rows }];
  if (!single)
    sections.push({
      heading: 'Subjects',
      columns: [
        { label: 'Code', width: 12 },
        { label: 'Subject', width: 30 },
        { label: 'Teacher', width: 22 },
      ],
      rows: r.courses.map((c) => [c.code, c.title === c.code ? '' : c.title, c.instructor ?? '']),
    });
  const c0 = r.courses[0];
  return {
    filename: `Attendly_${slug(r.scope.label)}_${stamp(r.generatedAt, r.timezone)}`,
    title: single && c0 ? `${c0.code}${c0.title !== c0.code ? ` · ${c0.title}` : ''} — attendance` : 'Attendance — all subjects',
    subtitle: r.scope.label,
    meta: [...header(r), ['Below minimum', `${below} of ${r.students.length} students`]],
    sections,
    wide: r.courses.length > 3,
  };
}

const PUNCT: Record<string, string> = { on_time: 'On time', late: 'Late', missed: 'Not held (never started)', cancelled: 'Cancelled' };

/** Professors' punctuality: a summary per professor, then every class with its two logs. */
export function punctualityReportDoc(r: PunctualityReport): ExportDoc {
  const one = r.teachers.length === 1 ? r.teachers[0] : undefined;
  return {
    filename: `Attendly_Professors_${one ? slug(one.name) + '_' : ''}${stamp(r.generatedAt, r.timezone)}`,
    title: one ? `${one.name} — punctuality` : 'Professors — punctuality',
    subtitle: `${dateOnly(r.from, r.timezone)} to ${dateOnly(r.to, r.timezone)}`,
    meta: [
      ['Institution', r.institution],
      ['Period', `${dateOnly(r.from, r.timezone)} – ${dateOnly(r.to, r.timezone)}`],
      ['Late means', 'started 2 minutes or more after the class time'],
      ['Data as of', when(r.generatedAt, r.timezone)],
    ],
    sections: [
      {
        heading: `${r.teachers.length} ${r.teachers.length === 1 ? 'professor' : 'professors'}`,
        columns: [
          { label: 'Professor', width: 26 },
          { label: 'Classes', kind: 'int', width: 9 },
          { label: 'On time', kind: 'int', width: 9 },
          { label: 'Late', kind: 'int', width: 7 },
          { label: 'Avg late (min)', width: 13 },
          { label: 'Not held', kind: 'int', width: 9 },
          { label: 'Cancelled', kind: 'int', width: 10 },
          { label: 'On time %', kind: 'pct', width: 10 },
        ],
        rows: r.teachers.map((t) => [t.name, t.classes, t.onTime, t.late, t.avgLateMin ?? '', t.missed, t.cancelled, t.onTimePercent]),
      },
      {
        heading: `Every class (${r.classes.length})`,
        columns: [
          { label: 'Class time', width: 20 },
          { label: 'Professor', width: 22 },
          { label: 'Subject', width: 12 },
          { label: 'Room', width: 10 },
          { label: 'Started', width: 10 },
          { label: 'Ended', width: 10 },
          { label: 'Status', width: 22 },
          { label: 'Late (min)', kind: 'int', width: 10 },
        ],
        rows: r.classes.map((c) => [
          when(c.scheduledStart, r.timezone),
          `${c.teacher}${c.substitute ? ' (cover)' : ''}`,
          c.courseCode,
          c.room ?? '',
          c.startedAt ? clock(c.startedAt, r.timezone) : '',
          c.endedAt ? clock(c.endedAt, r.timezone) : '',
          PUNCT[c.status] ?? c.status,
          c.lateMin,
        ]),
      },
    ],
    wide: true,
  };
}

// ───────────────────────────── PDF (HTML → print) ─────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const show = (v: Cell, kind?: Column['kind']) => (v === null || v === '' ? '—' : kind === 'pct' && typeof v === 'number' ? `${pct(v)}%` : String(v));

export function toHtml(d: ExportDoc): string {
  const table = (s: Section) => `
    <h2>${esc(s.heading)}</h2>
    <table>
      <thead><tr>${s.columns.map((c) => `<th class="${c.kind && c.kind !== 'text' ? 'n' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${
        s.rows.length
          ? s.rows
              .map(
                (r, i) =>
                  `<tr class="${s.strong?.includes(i) ? 'strong' : ''}">${r
                    .map((v, j) => {
                      const c = s.columns[j];
                      const low = v === 'Below minimum' || v === 'Absent';
                      return `<td class="${c?.kind && c.kind !== 'text' ? 'n' : ''}${low ? ' low' : ''}">${esc(show(v, c?.kind))}</td>`;
                    })
                    .join('')}</tr>`,
              )
              .join('')
          : `<tr><td colspan="${s.columns.length}" class="empty">Nothing to show yet.</td></tr>`
      }</tbody>
    </table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(d.filename)}</title>
<style>
  @page { size: A4 ${d.wide ? 'landscape' : 'portrait'}; margin: 16mm 12mm 18mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #111; font-size: 10.5px; margin: 0; }
  .brand { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 13px; letter-spacing: .2px; }
  .mark { display: grid; grid-template-columns: 6px 6px; gap: 2px; }
  .mark i { width: 6px; height: 6px; background: #111; display: block; }
  h1 { font-size: 20px; margin: 14px 0 2px; }
  .sub { color: #444; font-size: 12px; margin-bottom: 10px; }
  .meta { display: grid; grid-template-columns: repeat(${d.wide ? 5 : 3}, 1fr); gap: 6px 16px; padding: 10px 0; border-top: 1px solid #111; border-bottom: 1px solid #ddd; }
  .meta b { display: block; font-size: 8.5px; text-transform: uppercase; letter-spacing: .6px; color: #666; font-weight: 600; }
  h2 { font-size: 12px; margin: 18px 0 6px; text-transform: uppercase; letter-spacing: .6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .4px; color: #555; border-bottom: 1px solid #111; padding: 5px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #e6e6e6; vertical-align: top; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  .n { text-align: right; font-variant-numeric: tabular-nums; }
  .low { color: #b42318; font-weight: 600; }
  .strong td { font-weight: 700; border-top: 1px solid #111; }
  .empty { color: #777; text-align: center; padding: 14px; }
  .credit { margin-top: 26px; padding-top: 8px; border-top: 1px solid #111; display: flex; justify-content: space-between; font-size: 9.5px; color: #333; }
  .credit b { color: #111; }
</style></head><body>
  <div class="brand"><span class="mark"><i></i><i></i><i></i><i></i></span>Attendly</div>
  <h1>${esc(d.title)}</h1>
  <div class="sub">${esc(d.subtitle)}</div>
  <div class="meta">${d.meta.map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('')}</div>
  ${d.sections.map(table).join('')}
  <div class="credit"><span><b>Attendly</b> · Created by Atul Kumar Jena</span><span>${esc(d.filename)}</span></div>
</body></html>`;
}

// ───────────────────────────── Excel (.xlsx) ─────────────────────────────

const xml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** A minimal, valid Office Open XML workbook with one sheet (styles: bold, title, percent). */
export function toXlsx(d: ExportDoc): Uint8Array {
  const S = { text: 0, bold: 1, pct: 2, title: 3, head: 4, boldPct: 5, int: 6, boldInt: 7, muted: 8 };
  const rows: string[] = [];
  let r = 0;
  const put = (cells: { v: Cell; s?: number }[]) => {
    r++;
    const cs = cells
      .map((c, i) => {
        const ref = `${colName(i)}${r}`;
        if (c.v === null || c.v === '') return `<c r="${ref}"${c.s ? ` s="${c.s}"` : ''}/>`;
        if (typeof c.v === 'number' && Number.isFinite(c.v)) return `<c r="${ref}"${c.s ? ` s="${c.s}"` : ''}><v>${c.v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${c.s ? ` s="${c.s}"` : ''}><is><t xml:space="preserve">${xml(String(c.v))}</t></is></c>`;
      })
      .join('');
    rows.push(`<row r="${r}">${cs}</row>`);
  };
  put([{ v: `Attendly — ${d.title}`, s: S.title }]);
  put([{ v: d.subtitle, s: S.bold }]);
  for (const [k, v] of d.meta) put([{ v: k, s: S.muted }, { v }]);
  const widths: number[] = [18, 26];
  for (const sec of d.sections) {
    put([]);
    put([{ v: sec.heading, s: S.bold }]);
    put(sec.columns.map((c) => ({ v: c.label, s: S.head })));
    sec.rows.forEach((row, ri) => {
      const strong = sec.strong?.includes(ri);
      put(row.map((v, i) => {
        const k = sec.columns[i]?.kind;
        return { v, s: k === 'pct' ? (strong ? S.boldPct : S.pct) : k === 'int' ? (strong ? S.boldInt : S.int) : strong ? S.bold : S.text };
      }));
    });
    sec.columns.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.width ?? 12)));
  }
  put([]);
  put([{ v: CREDIT, s: S.bold }]);

  const cols = `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${cols}<sheetData>${rows.join('')}</sheetData><pageSetup orientation="${d.wide ? 'landscape' : 'portrait'}"/><headerFooter><oddFooter>&amp;L${xml(CREDIT)}&amp;RPage &amp;P of &amp;N</oddFooter></headerFooter></worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot;%&quot;"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="15"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF111111"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(d.title)}</dc:title><dc:creator>Attendly — created by Atul Kumar Jena</dc:creator></cp:coreProperties>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Attendance" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': sheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 });
}

// ───────────────────────────── save / share ─────────────────────────────

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function webDownload(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function shareNative(uri: string, mimeType: string, name: string, UTI: string) {
  const Sharing = await import('expo-sharing');
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing isn’t available on this phone.');
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: name, UTI });
}

/** Builds the file and opens the share sheet (save to Files / Drive, WhatsApp, email…). */
export async function downloadDoc(d: ExportDoc, format: 'pdf' | 'xlsx'): Promise<void> {
  const name = `${d.filename}.${format}`;
  if (format === 'xlsx') {
    const bytes = toXlsx(d);
    if (Platform.OS === 'web') return webDownload(name, bytes as unknown as BlobPart, XLSX_MIME);
    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    file.write(bytes);
    return shareNative(file.uri, XLSX_MIME, name, 'org.openxmlformats.spreadsheetml.sheet');
  }
  const html = toHtml(d);
  if (Platform.OS === 'web') {
    // The browser's print dialog → "Save as PDF".
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    document.body.appendChild(frame);
    const w = frame.contentWindow!;
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => {
      w.focus();
      w.print();
      setTimeout(() => frame.remove(), 60_000);
    }, 250);
    return;
  }
  const [Print, { File, Paths }] = await Promise.all([import('expo-print'), import('expo-file-system')]);
  const out = await Print.printToFileAsync({ html, width: d.wide ? 842 : 595, height: d.wide ? 595 : 842 });
  // Give the file a readable name (the printer picks a random one); fall back to it if renaming fails.
  let uri = out.uri;
  try {
    const dest = new File(Paths.cache, name);
    if (dest.exists) dest.delete();
    await new File(out.uri).move(dest);
    uri = dest.uri;
  } catch {
    // keep the printer's file
  }
  return shareNative(uri, 'application/pdf', name, 'com.adobe.pdf');
}
