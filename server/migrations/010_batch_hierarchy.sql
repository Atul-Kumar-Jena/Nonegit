-- Batch-first hierarchy: a batch (e.g. "CSE-A") belongs to a department and a semester,
-- holds its students and the subjects they take. Teachers can create batches; the creator
-- (and admins) can remove, rename, archive or move it to the next semester.
alter table batches add column department text check (department is null or length(department) between 1 and 60);
alter table batches add column semester int check (semester is null or semester between 1 and 20);
alter table batches add column created_by uuid references users(id) on delete set null;
create index batches_tenant_semester_idx on batches(tenant_id, semester);
