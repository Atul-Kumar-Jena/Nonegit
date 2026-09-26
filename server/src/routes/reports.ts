/**
 * Attendance reports (view + download as PDF / Excel in the apps).
 * Students read their own; every teacher and admin can read any student, batch or subject
 * in their institution (read-only).
 */
import type { FastifyInstance } from 'fastify';
import { MatrixQuery, StudentReportQuery, type MatrixReport, type StudentReport } from '@attendly/protocol';
import type { Deps } from '../deps';
import { STAFF } from '../lib/access';
import { requireDevice } from '../lib/auth';
import { z } from 'zod';
import { buildMatrixReport, buildStudentReport } from '../lib/reports';

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
}
