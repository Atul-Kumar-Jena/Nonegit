/**
 * Turns a pasted class list (Excel / Google Sheets / CSV / a PDF copy) into rows
 * for the bulk-import API. With a header row the columns are taken from it;
 * without one each cell is recognised by its shape.
 */
export type ImportRow = {
  fullName: string;
  rollNo?: string;
  email?: string;
  phone?: string;
  department?: string;
  semester?: number;
  role: 'student' | 'teacher';
};

type Col = 'fullName' | 'rollNo' | 'email' | 'phone' | 'department' | 'semester';
const HEADERS: [RegExp, Col][] = [
  [/^(full\s*)?name|^student|^teacher/i, 'fullName'],
  [/^roll|^reg(istration)?\b|^enrol+ment|^id\b|^usn/i, 'rollNo'],
  [/^e-?mail/i, 'email'],
  [/^(phone|mobile|contact|whatsapp)/i, 'phone'],
  [/^(dept|department|branch|programme|program)/i, 'department'],
  [/^(sem|semester|year)/i, 'semester'],
];

/** Split one line: tabs (spreadsheet), else commas, else semicolons; handles "quoted, cells". */
export function splitCells(line: string): string[] {
  const sep = line.includes('\t') ? '\t' : line.includes(',') ? ',' : ';';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === sep && !quoted) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normPhone = (v: string) => v.replace(/[\s()-]/g, '');
const PHONE = /^\+[1-9]\d{7,14}$/;

function put(row: ImportRow, col: Col, v: string) {
  if (!v) return;
  if (col === 'email') row.email = v.toLowerCase();
  else if (col === 'phone') {
    const p = normPhone(v);
    row.phone = p.startsWith('+') ? p : /^\d{10}$/.test(p) ? `+91${p}` : p; // bare 10-digit numbers: India
  } else if (col === 'semester') {
    const n = Number(v.replace(/\D/g, ''));
    if (Number.isInteger(n) && n >= 1 && n <= 20) row.semester = n;
  } else row[col] = v;
}

export function parseRows(text: string, role: 'student' | 'teacher'): { rows: ImportRow[]; problems: string[] } {
  const rows: ImportRow[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let columns: (Col | null)[] | null = null;

  lines.forEach((line, i) => {
    const c = splitCells(line);
    if (i === 0) {
      const mapped = c.map((h) => HEADERS.find(([re]) => re.test(h))?.[1] ?? null);
      if (mapped.includes('fullName') && mapped.filter(Boolean).length >= 2) {
        columns = mapped;
        return;
      }
    }
    const row: ImportRow = { fullName: '', role };
    if (columns) {
      columns.forEach((col, j) => col && put(row, col, c[j] ?? ''));
    } else {
      for (const v of c) {
        if (!v) continue;
        if (!row.email && EMAIL.test(v)) put(row, 'email', v);
        else if (!row.phone && PHONE.test(normPhone(v))) put(row, 'phone', v);
        else if (role === 'student' && !row.semester && /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= 20) put(row, 'semester', v);
        else if (role === 'student' && !row.rollNo && /\d/.test(v) && !/\s/.test(v) && v.length <= 40) put(row, 'rollNo', v);
        else if (!row.fullName && /\p{L}/u.test(v)) put(row, 'fullName', v);
        else if (!row.department && v.length <= 60) put(row, 'department', v);
      }
    }
    if (role === 'teacher') {
      delete row.rollNo;
      delete row.semester;
    }
    if (!row.fullName) problems.push(`Line ${i + 1}: no name found`);
    else if (row.email && !EMAIL.test(row.email)) problems.push(`Line ${i + 1}: “${row.email}” isn’t an email address`);
    else if (row.phone && !PHONE.test(row.phone)) problems.push(`Line ${i + 1}: phone “${row.phone}” needs a country code, e.g. +91…`);
    else if (!row.email && !row.phone) problems.push(`Line ${i + 1}: ${row.fullName} has no email or phone`);
    else rows.push(row);
  });
  return { rows, problems };
}
