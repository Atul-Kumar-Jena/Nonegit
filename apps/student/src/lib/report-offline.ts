/**
 * Offline fallback for downloads: rebuilds a report from what the phone already has
 * (dashboard, subjects, subject history), so "Download" never dead-ends without internet.
 */
import type { QueryClient } from '@tanstack/react-query';
import { attendancePercent, standing, type DashboardResponse, type StudentReport, type SubjectDetailResponse, type SubjectsResponse } from '@attendly/protocol';
import { qk } from '@/state/queries';

export function offlineReport(qc: QueryClient, courseId?: string): StudentReport | undefined {
  const dash = qc.getQueryData<DashboardResponse>(qk.dashboard);
  const subs = qc.getQueryData<SubjectsResponse>(qk.subjects);
  const cached = qc.getQueryData<StudentReport>(qk.report());
  if (!dash) return undefined;
  const min = subs?.minPercent ?? dash.term.minPercent;
  let subjects: StudentReport['subjects'] =
    cached?.subjects ??
    (subs?.subjects ?? []).map((s) => ({ courseId: s.courseId, code: s.code, title: s.title, instructor: s.instructor, attended: s.attended, held: s.held, percent: s.percent, standing: s.standing }));
  let classes: StudentReport['classes'] = null;
  if (courseId) {
    subjects = subjects.filter((s) => s.courseId === courseId);
    const detail = qc.getQueryData<SubjectDetailResponse>(qk.subject(courseId));
    if (!subjects.length && detail) {
      const s = detail.subject;
      subjects = [{ courseId: s.courseId, code: s.code, title: s.title, instructor: s.instructor, attended: s.attended, held: s.held, percent: s.percent, standing: s.standing }];
    }
    if (!subjects.length) return undefined;
    const code = subjects[0]!.code;
    classes = (detail?.history ?? [])
      .filter((h) => h.status === 'present' || h.status === 'absent' || h.status === 'live')
      .sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart))
      .map((h) => ({
        sessionId: h.sessionId,
        courseCode: code,
        start: h.scheduledStart,
        status: h.status as 'present' | 'absent' | 'live',
        how: h.status === 'present' ? (h.source === 'manual' ? 'Register' : h.source === 'review' ? 'Approved by teacher' : h.source === 'import' ? 'Imported' : 'QR scan') : null,
      }));
  }
  const attended = subjects.reduce((n, s) => n + s.attended, 0);
  const held = subjects.reduce((n, s) => n + s.held, 0);
  return {
    institution: dash.user.institution.name,
    termName: subs?.termName ?? dash.term.name,
    minPercent: min,
    timezone: dash.timezone,
    generatedAt: new Date(qc.getQueryState(qk.subjects)?.dataUpdatedAt || qc.getQueryState(qk.dashboard)?.dataUpdatedAt || Date.now()).toISOString(),
    student: { userId: dash.user.id, fullName: dash.user.fullName, rollNo: dash.user.rollNo, batches: cached?.student.batches ?? [] },
    subjects,
    total: { attended, held, percent: attendancePercent(attended, held), standing: standing(attended, held, min) },
    classes,
  };
}
