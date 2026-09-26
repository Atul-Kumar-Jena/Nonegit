-- Attendly schema v2: institute app (teachers, rooms, timetable, manual registers, offline sync).

-- ── people ────────────────────────────────────────────────────────────────
alter table users drop constraint users_role_check;
alter table users add constraint users_role_check check (role in ('student', 'teacher', 'admin', 'developer'));
alter table users add column created_by uuid references users(id) on delete set null;
create index users_tenant_role_idx on users(tenant_id, role);

-- ── sessions: absolute lifetime for a login (staff re-authenticate daily) ─
alter table auth_sessions add column family_expires_at timestamptz;
update auth_sessions set family_expires_at = refresh_expires_at where family_expires_at is null;
alter table auth_sessions alter column family_expires_at set not null;

-- ── rooms (saved geofences) ──────────────────────────────────────────────
create table rooms (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (length(name) between 1 and 60),
  lat         double precision check (lat between -90 and 90),
  lng         double precision check (lng between -180 and 180),
  radius_m    int not null default 50 check (radius_m between 10 and 1000),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name),
  check ((lat is null) = (lng is null))
);

-- ── courses ──────────────────────────────────────────────────────────────
alter table courses add column default_mode text not null default 'qr' check (default_mode in ('qr', 'manual'));
alter table courses add column active boolean not null default true;
create index courses_instructor_idx on courses(instructor_id);

-- ── weekly timetable ─────────────────────────────────────────────────────
create table timetable_slots (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  course_id    uuid not null references courses(id) on delete cascade,
  weekday      smallint not null check (weekday between 0 and 6), -- 0 = Sunday
  start_time   time not null,
  end_time     time not null,
  room_id      uuid references rooms(id) on delete set null,
  mode         text not null default 'qr' check (mode in ('qr', 'manual')),
  rotation_s   int not null default 7 check (rotation_s between 3 and 60),
  valid_from   date not null default current_date,
  valid_until  date,
  active       boolean not null default true,
  created_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (end_time > start_time),
  check (valid_until is null or valid_until >= valid_from)
);
create index timetable_slots_tenant_idx on timetable_slots(tenant_id) where active;
create index timetable_slots_course_idx on timetable_slots(course_id);

-- ── class sessions ───────────────────────────────────────────────────────
alter table class_sessions alter column lat drop not null;
alter table class_sessions alter column lng drop not null;
alter table class_sessions add column mode text not null default 'qr' check (mode in ('qr', 'manual'));
alter table class_sessions add column slot_id uuid references timetable_slots(id) on delete set null;
alter table class_sessions add column room_id uuid references rooms(id) on delete set null;
alter table class_sessions add column started_by uuid references users(id) on delete set null;
alter table class_sessions add column ended_by uuid references users(id) on delete set null;
-- One occurrence per slot per start time: timetable materialisation is idempotent.
create unique index class_sessions_slot_occurrence on class_sessions(slot_id, scheduled_start) where slot_id is not null;
-- A live QR session always has a geofence.
alter table class_sessions add constraint class_sessions_live_qr_located
  check (mode = 'manual' or status <> 'live' or (lat is not null and lng is not null));

-- ── attendance records ───────────────────────────────────────────────────
alter table attendance_records drop constraint attendance_records_source_check;
alter table attendance_records add constraint attendance_records_source_check check (source in ('scan', 'manual', 'import', 'review'));
alter table attendance_records add column marked_by uuid references users(id) on delete set null;
alter table attendance_records add column offline boolean not null default false;
alter table attendance_records add column revoked_at timestamptz;
alter table attendance_records add column revoked_by uuid references users(id) on delete set null;
alter table attendance_records add column revoke_reason text;
alter table attendance_records add constraint attendance_records_revoke_reason check (revoked_at is null or revoke_reason is not null);
create index attendance_records_session_idx on attendance_records(session_id);

-- ── idempotency for offline-synced staff actions ─────────────────────────
create table client_actions (
  user_id      uuid not null references users(id) on delete cascade,
  client_ref   text not null,
  kind         text not null,
  result       jsonb not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, client_ref)
);

-- ── one pending device request per person also for staff (unchanged) ─────
