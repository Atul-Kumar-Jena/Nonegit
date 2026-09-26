import { describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { writeFileSync } from 'node:fs';
import type { MatrixReport, StudentReport } from '@attendly/protocol';

vi.mock('react-native', () => ({ Platform: { OS: 'node' } }));
const { CREDIT, matrixReportDoc, studentReportDoc, toHtml, toXlsx } = await import('../src/lib/export');

const head = { institution: 'Demo Institute <&>', termName: 'Autumn 2026', minPercent: 75, timezone: 'Asia/Kolkata', generatedAt: '2026-09-26T09:30:00.000Z' };
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const student: StudentReport = {
  ...head,
  student: { userId: id(1), fullName: 'Aarav Reddy', rollNo: '21CS001', batches: ['CSE-A'] },
  subjects: [
    { courseId: id(2), code: 'CS-301', title: 'Operating Systems', instructor: 'Dr. N. Iyer', attended: 9, held: 10, percent: 90, standing: 'safe' },
    { courseId: id(3), code: 'MA-202', title: 'MA-202', instructor: null, attended: 1, held: 4, percent: 25, standing: 'at-risk' },
  ],
  total: { attended: 10, held: 14, percent: 71.4, standing: 'at-risk' },
  classes: null,
};
const matrix: MatrixReport = {
  ...head,
  scope: { batchId: id(4), batchName: 'CSE-A', courseId: null, label: 'CSE-A' },
  courses: [
    { courseId: id(2), code: 'CS-301', title: 'Operating Systems', instructor: 'Dr. N. Iyer' },
    { courseId: id(3), code: 'MA-202', title: 'Maths', instructor: null },
  ],
  students: [
    { userId: id(1), fullName: 'Aarav Reddy', rollNo: '21CS001', cells: [{ attended: 9, held: 10 }, null], attended: 9, held: 10, percent: 90, standing: 'safe' },
    { userId: id(5), fullName: '=HYPERLINK("x")', rollNo: null, cells: [{ attended: 0, held: 0 }, { attended: 1, held: 4 }], attended: 1, held: 4, percent: 25, standing: 'at-risk' },
  ],
};

describe('report downloads', () => {
  it('student report: per subject + cumulative, credit at the end, HTML escaped', () => {
    const d = studentReportDoc(student);
    expect(d.filename).toBe('Attendly_21CS001_2026-09-26');
    expect(d.sections[0]!.rows.at(-1)).toEqual(['All subjects', 'Cumulative', '', 10, 14, 71.4, 'Below minimum']);
    const html = toHtml(d);
    expect(html).toContain('Demo Institute &lt;&amp;&gt;');
    expect(html).toContain('Created by Atul Kumar Jena');
    expect(html.lastIndexOf('Created by Atul Kumar Jena')).toBeGreaterThan(html.lastIndexOf('</table>'));
  });

  it('one subject adds the class-by-class log', () => {
    const d = studentReportDoc({ ...student, subjects: [student.subjects[0]!], classes: [{ sessionId: id(6), courseCode: 'CS-301', start: '2026-09-21T04:30:00.000Z', status: 'present', how: 'QR scan' }] });
    expect(d.filename).toBe('Attendly_21CS001_CS-301_2026-09-26');
    expect(d.sections[1]!.rows).toEqual([[1, '21 Sep 2026', '10:00 AM', 'Present', 'QR scan']]);
  });

  it('xlsx is a valid package, numbers stay numbers, text is never a formula, and it ends with the credit', () => {
    const bytes = toXlsx(matrixReportDoc(matrix));
    if (process.env.EXPORT_SAMPLES) {
      writeFileSync(`${process.env.EXPORT_SAMPLES}/sample.xlsx`, bytes);
      writeFileSync(`${process.env.EXPORT_SAMPLES}/matrix.html`, toHtml(matrixReportDoc(matrix)));
      writeFileSync(`${process.env.EXPORT_SAMPLES}/student.html`, toHtml(studentReportDoc(student)));
    }
    const z = unzipSync(bytes);
    expect(Object.keys(z).sort()).toEqual(['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    const sheet = strFromU8(z['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<v>90</v>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).toContain('=HYPERLINK(&quot;x&quot;)');
    const lastRow = sheet.slice(sheet.lastIndexOf('<row'));
    expect(lastRow).toContain(CREDIT);
  });
});
