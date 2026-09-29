-- Layered scans (fests, webinars): the professor asks for 1–5 scans per class; a student is present
-- only after scanning in every round. Round 1 opens when the class starts; each later round opens
-- when the professor shows its code (round_opened_at[i] = when round i+2 opened).
alter table class_sessions
  add column scan_rounds smallint not null default 1 check (scan_rounds between 1 and 5),
  add column round_no smallint not null default 1 check (round_no between 1 and 5),
  add column round_opened_at timestamptz[] not null default '{}',
  -- Why the class ended: null = the professor (or the clock) ended it; 'all_marked' = everyone was marked.
  add column end_reason text check (end_reason in ('all_marked'));

create table scan_round_marks (
  session_id uuid not null references class_sessions(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  round      smallint not null check (round between 1 and 5),
  device_id  uuid references devices(id) on delete set null,
  marked_at  timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id, round)
);

-- Shorter-lived QR codes: new classes rotate every 5 s (a screenshot goes stale before it can be shared).
alter table timetable_slots alter column rotation_s set default 5;
update timetable_slots set rotation_s = 5 where rotation_s = 7;
update class_sessions set rotation_s = 5 where rotation_s = 7 and status = 'scheduled';

-- Scale: the hottest lookups get their own indexes.
create index if not exists attendance_records_session_live on attendance_records(session_id) where revoked_at is null;
create index if not exists class_sessions_tenant_start on class_sessions(tenant_id, scheduled_start);
create index if not exists class_sessions_live on class_sessions(status) where status = 'live';
create index if not exists notifications_user_recent on notifications(user_id, id desc);
create index if not exists enrollments_user on enrollments(user_id);
create index if not exists scan_rejections_device_recent on scan_rejections(device_id, created_at desc);

-- Instant push: which notifications Google accepted for the person's phone (the apps show the rest themselves).
alter table notifications add column if not exists push_ok boolean not null default false;

-- "Starts in 5 min" reminders sent by the server (instant push; works even if the app hasn't opened).
alter table class_sessions add column if not exists reminded_at timestamptz;
