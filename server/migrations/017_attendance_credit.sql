-- Attendance credit: classes counted as attended for a reason (medical leave, a fest, sports, college
-- duty…), with a note. Each credited class is an ordinary attendance record marked 'credit', so every
-- percentage, report and export includes it.
create table attendance_credits (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  course_id   uuid references courses(id) on delete cascade, -- null: every subject
  reason      text not null check (reason in ('medical', 'event', 'sports', 'duty', 'other')),
  note        text not null check (length(note) between 3 and 300),
  requested   text not null,
  credited    int not null,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  undone_at   timestamptz,
  undone_by   uuid references users(id) on delete set null
);
create index attendance_credits_user_idx on attendance_credits(user_id, created_at desc);

alter table attendance_records drop constraint attendance_records_source_check;
alter table attendance_records add constraint attendance_records_source_check check (source in ('scan', 'manual', 'import', 'review', 'credit'));
alter table attendance_records add column credit_id uuid references attendance_credits(id) on delete set null;
