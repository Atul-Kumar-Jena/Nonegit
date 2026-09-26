-- Requests about one class: "please take my class" (cover) and students asking their teacher.
create table change_requests (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  kind             text not null check (kind in ('cover', 'student')),
  topic            text not null check (topic in ('cover', 'reschedule', 'extra', 'cancel', 'doubt', 'other')),
  session_id       uuid not null references class_sessions(id) on delete cascade,
  requested_by     uuid not null references users(id) on delete cascade,
  -- The teacher who has to answer.
  target_id        uuid not null references users(id) on delete cascade,
  note_to_teacher  text check (note_to_teacher is null or length(note_to_teacher) <= 500),
  note_to_students text check (note_to_students is null or length(note_to_students) <= 300),
  status           text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  reply            text check (reply is null or length(reply) <= 300),
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       uuid references users(id) on delete set null,
  check ((kind = 'cover') = (topic = 'cover')),
  check (status = 'pending' or decided_at is not null)
);
-- One open cover request per class; one open question per student per class.
create unique index change_requests_one_cover on change_requests(session_id) where kind = 'cover' and status = 'pending';
create unique index change_requests_one_student on change_requests(session_id, requested_by) where kind = 'student' and status = 'pending';
create index change_requests_target_idx on change_requests(target_id, status, created_at desc);
create index change_requests_from_idx on change_requests(requested_by, status, created_at desc);
