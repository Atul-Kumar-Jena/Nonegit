/**
 * Attendance reports (view + download as PDF / Excel in the apps).
 * Students read their own; every teacher and admin can read any student, batch or subject
 * in their institution (read-only).
 */
import type { FastifyInstance } from 'fastify';
import { AnalyticsQuery, MatrixQuery, PunctualityQuery, StudentReportQuery, type AttendanceAnalytics, type MatrixReport, type PunctualityReport, type StudentTrend, type StudentReport } from '@attendly/protocol';
import type { Deps } from '../deps';
import { STAFF, can } from '../lib/access';
import { requireDevice } from '../lib/auth';
import { z } from 'zod';
import { buildAnalytics, buildMatrixReport, buildPunctualityReport, buildStudentReport, buildStudentTrend } from '../lib/reports';

const IdParam = z.object({ id: z.uuid() });

export async function reportRoutes(app: FastifyInstance, deps: Deps) {
  app.get('/v1/me/report', async (req): Promise<StudentReport> => {
    const auth = await requireDevice(req, deps, ['student']);
    const q = StudentReportQuery.parse(req.query);
    return buildStudentReport(deps.db, auth.tenantId, auth.userId, deps.clock(), q.courseId);
  });

  app.get('/v1/staff/students/:id/report', async (req): Promise<StudentReport> => {
    const auth = await requireDevice(req, deps, STAFF);
    const { id } = IdParam.parse(req.params);
    const q = StudentReportQuery.parse(req.query);
    return buildStudentReport(deps.db, auth.tenantId, id, deps.clock(), q.courseId);
  });

  app.get('/v1/staff/reports/matrix', async (req): Promise<MatrixReport> => {
    const auth = await requireDevice(req, deps, STAFF);
    return buildMatrixReport(deps.db, auth.tenantId, deps.clock(), MatrixQuery.parse(req.query));
  });

  /** Charts: attendance per day / subject / batch and the spread of students (a professor: their own classes). */
  app.get('/v1/staff/analytics', async (req): Promise<AttendanceAnalytics> => {
    const auth = await requireDevice(req, deps, STAFF);
    const q = AnalyticsQuery.parse(req.query);
    const everyone = can(auth, 'courses') || can(auth, 'planner');
    return buildAnalytics(deps.db, auth.tenantId, deps.clock(), q, everyone ? (q.teacherId ?? null) : auth.userId, !everyone);
  });

  /** A student's week-by-week trend (Home chart). */
  app.get('/v1/me/trend', async (req): Promise<StudentTrend> => {
    const auth = await requireDevice(req, deps, ['student']);
    return buildStudentTrend(deps.db, auth.tenantId, auth.userId, 12);
  });

  /** Professors' punctuality: admins (and coordinators) see everyone; a professor sees their own. */
  app.get('/v1/staff/reports/punctuality', async (req): Promise<PunctualityReport> => {
    const auth = await requireDevice(req, deps, STAFF);
    const q = PunctualityQuery.parse(req.query);
    const everyone = can(auth, 'courses') || can(auth, 'planner');
    return buildPunctualityReport(deps.db, auth.tenantId, deps.clock(), { days: q.days, teacherId: everyone ? q.teacherId : auth.userId });
  });
}
