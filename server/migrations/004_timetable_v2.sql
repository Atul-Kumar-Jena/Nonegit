-- Timetable v2: batches, one-off adjustments (reschedule / cancel / substitute /
-- extra), drafts published from the drag-and-drop planner, and notifications.

-- ───────────── batches (sections / classes / years) ─────────────
create table batches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null check (length(name) between 1 and 60),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);
create table batch_members (
  batch_id  uuid not null references batches(id) on delete cascade,
  user_id   uuid not null references users(id) on delete cascade,
  primary key (batch_id, user_id)
);
create index batch_members_user_idx on batch_members(user_id);
create table course_batches (
  course_id  uuid not null references courses(id) on delete cascade,
  batch_id   uuid not null references batches(id) on delete cascade,
  primary key (course_id, batch_id)
);
create index course_batches_batch_idx on course_batches(batch_id);
-- null = enrolled directly; otherwise the batch that brought the student into the course.
alter table enrollments add column batch_id uuid references batches(id) on delete cascade;

-- ───────────── one-off adjustments on a single class ─────────────
alter table class_sessions add column slot_date date;
update class_sessions s set slot_date = (s.scheduled_start at time zone t.timezone)::date
  from tenants t where t.id = s.tenant_id and s.slot_id is not null;
-- One class per weekly slot per *day* (not per start time), so a rescheduled
-- occurrence is never re-created by the timetable at its old time.
drop index class_sessions_slot_occurrence;
create unique index class_sessions_slot_day on class_sessions(slot_id, slot_date) where slot_id is not null;
alter table class_sessions add constraint class_sessions_slot_date check ((slot_id is null) or (slot_date is not null));

alter table class_sessions add column original_start timestamptz;       -- set when a class is moved
alter table class_sessions add column substitute_id uuid references users(id) on delete set null;
alter table class_sessions add column change_kind text check (change_kind in ('rescheduled', 'substitute', 'extra', 'cancelled'));
alter table class_sessions add column change_note text;
alter table class_sessions add column changed_at timestamptz;
alter table class_sessions add column changed_by uuid references users(id) on delete set null;
create index class_sessions_substitute_idx on class_sessions(substitute_id) where substitute_id is not null;

-- ───────────── notifications ─────────────
create table notifications (
  id          bigserial primary key,
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null,
  title       text not null,
  body        text not null,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index notifications_user_idx on notifications(user_id, id desc);

-- ───────────── planner drafts ─────────────
create table timetable_drafts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  title         text not null,
  week_start    date not null,
  ops           jsonb not null default '[]',
  version       integer not null default 1,
  status        text not null default 'draft' check (status in ('draft', 'published', 'discarded')),
  note          text,
  created_by    uuid references users(id) on delete set null,
  updated_by    uuid references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz,
  published_by  uuid references users(id) on delete set null
);
create index timetable_drafts_tenant_idx on timetable_drafts(tenant_id, status, updated_at desc);
