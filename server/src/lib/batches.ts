import type { Queryable } from '../db';

/**
 * Makes course enrollments match batch membership exactly:
 *   every member of an active batch attached to a course is enrolled in it, and
 *   enrollments that came from a batch disappear when that link no longer holds.
 * Students enrolled directly (batch_id null) are never touched. Idempotent.
 */
export async function reconcileBatchEnrollments(tx: Queryable, tenantId: string): Promise<void> {
  await tx.query(
    `delete from enrollments e
      using courses c
      where c.id = e.course_id and c.tenant_id = $1 and e.batch_id is not null
        and not exists (
          select 1 from course_batches cb
            join batches b on b.id = cb.batch_id and b.active
            join batch_members m on m.batch_id = cb.batch_id
           where cb.course_id = e.course_id and m.user_id = e.user_id)`,
    [tenantId],
  );
  await tx.query(
    `insert into enrollments(course_id, user_id, batch_id)
     select cb.course_id, m.user_id, (array_agg(cb.batch_id order by b.name))[1]
       from course_batches cb
       join batches b on b.id = cb.batch_id and b.active and b.tenant_id = $1
       join batch_members m on m.batch_id = cb.batch_id
      group by cb.course_id, m.user_id
     on conflict (course_id, user_id) do nothing`,
    [tenantId],
  );
}
