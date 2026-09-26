-- Attendly schema v1
-- Every table that stores a secret stores only a keyed hash of it.

create table tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name            text not null check (length(name) between 1 and 120),
  email_domains   text[] not null default '{}',
  timezone        text not null default 'Asia/Kolkata',
  min_attendance  numeric(5,2) not null default 75 check (min_attendance between 0 and 100),
  term_name       text not null default 'Current term',
  term_start      date not null default current_date,
  device_reset_limit int not null default 2 check (device_reset_limit between 0 and 20),
  status          text not null default 'active' check (status in ('active', 'suspended')),
  created_at      timestamptz not null default now()
);

create table users (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  role        text not null check (role in ('student', 'admin', 'developer')),
  full_name   text not null check (length(full_name) between 1 and 120),
  email       text unique check (email is null or email = lower(email)),
  phone       text unique check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  roll_no     text,
  department  text,
  semester    int check (semester is null or semester between 1 and 20),
  status      text not null default 'active' check (status in ('active', 'suspended')),
  created_at  timestamptz not null default now(),
  check (email is not null or phone is not null),
  unique (tenant_id, roll_no)
);

create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  public_key    bytea not null check (length(public_key) = 32),
  fingerprint   text not null,
  platform      text not null check (platform in ('ios', 'android', 'web')),
  model         text not null,
  os_version    text not null,
  app_version   text not null,
  status        text not null check (status in ('active', 'revoked')),
  bound_at      timestamptz not null default now(),
  revoked_at    timestamptz,
  revoke_reason text,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);
-- One student, one device — and one device, one student. Revoked rows are kept as history,
-- so a phone that was unbound can be bound again.
create unique index devices_one_active_per_user on devices(user_id) where status = 'active';
create unique index devices_one_active_per_key on devices(public_key) where status = 'active';

create table otp_challenges (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references users(id) on delete cascade,
  channel      text not null check (channel in ('email', 'phone')),
  identifier   text not null,
  code_hash    bytea not null,
  attempts     int not null default 0,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  request_ip   text,
  created_at   timestamptz not null default now()
);
create index otp_challenges_identifier_idx on otp_challenges(identifier, created_at desc);

-- Short-lived single-use tickets that bridge OTP verification and device binding.
create table auth_tickets (
  id           uuid primary key default gen_random_uuid(),
  token_hash   bytea not null unique,
  kind         text not null check (kind in ('bind', 'rebind')),
  user_id      uuid not null references users(id) on delete cascade,
  public_key   bytea not null check (length(public_key) = 32),
  device_info  jsonb not null,
  expires_at   timestamptz not null,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now()
);

create table auth_sessions (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null,
  parent_id           uuid references auth_sessions(id) on delete set null,
  user_id             uuid not null references users(id) on delete cascade,
  device_id           uuid not null references devices(id) on delete cascade,
  access_hash         bytea not null unique,
  access_expires_at   timestamptz not null,
  refresh_hash        bytea not null unique,
  refresh_expires_at  timestamptz not null,
  rotated_at          timestamptz,
  revoked_at          timestamptz,
  revoke_reason       text,
  last_used_at        timestamptz,
  created_at          timestamptz not null default now()
);
create index auth_sessions_family_idx on auth_sessions(family_id);
create index auth_sessions_device_idx on auth_sessions(device_id);

-- Replay protection for signed requests.
create table request_nonces (
  device_id   uuid not null references devices(id) on delete cascade,
  nonce       text not null,
  expires_at  timestamptz not null,
  primary key (device_id, nonce)
);
create index request_nonces_expiry_idx on request_nonces(expires_at);

create table courses (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  code           text not null,
  title          text not null,
  kind           text not null default 'theory' check (kind in ('theory', 'lab')),
  instructor_id  uuid references users(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (tenant_id, code)
);

create table enrollments (
  course_id   uuid not null references courses(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (course_id, user_id)
);
create index enrollments_user_idx on enrollments(user_id);

create table class_sessions (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  course_id        uuid not null references courses(id) on delete cascade,
  short_code       text not null unique,
  lecture_no       int,
  room             text,
  lat              double precision not null check (lat between -90 and 90),
  lng              double precision not null check (lng between -180 and 180),
  radius_m         int not null check (radius_m between 10 and 1000),
  rotation_s       int not null check (rotation_s between 3 and 60),
  qr_secret        bytea not null check (length(qr_secret) = 32),
  status           text not null check (status in ('scheduled', 'live', 'closed', 'cancelled')),
  scheduled_start  timestamptz not null,
  scheduled_end    timestamptz not null,
  started_at       timestamptz,
  ended_at         timestamptz,
  created_by       uuid references users(id) on delete set null,
  created_at       timestamptz not null default now(),
  check (scheduled_end > scheduled_start),
  check (status not in ('live', 'closed') or started_at is not null)
);
create index class_sessions_course_idx on class_sessions(course_id, status);
create index class_sessions_sched_idx on class_sessions(tenant_id, scheduled_start);

create table attendance_records (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references class_sessions(id) on delete cascade,
  user_id            uuid not null references users(id) on delete cascade,
  device_id          uuid references devices(id) on delete set null,
  marked_at          timestamptz not null,
  qr_seq             int not null,
  lat                double precision,
  lng                double precision,
  accuracy_m         double precision,
  distance_m         double precision,
  device_signature   bytea,
  request_digest     bytea,
  receipt_signature  bytea not null,
  server_key_id      text not null,
  device_fingerprint text not null,
  source             text not null default 'scan' check (source in ('scan', 'manual', 'import')),
  unique (session_id, user_id)
);
create index attendance_records_user_idx on attendance_records(user_id);

create table scan_rejections (
  id             bigserial primary key,
  tenant_id      uuid references tenants(id) on delete cascade,
  session_id     uuid references class_sessions(id) on delete cascade,
  user_id        uuid references users(id) on delete cascade,
  device_id      uuid references devices(id) on delete set null,
  code           text not null,
  suspicious     boolean not null,
  detail         jsonb not null default '{}',
  review_status  text not null default 'open' check (review_status in ('open', 'valid', 'blocked', 'dismissed')),
  reviewed_by    uuid references users(id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index scan_rejections_session_idx on scan_rejections(session_id, created_at desc);
create index scan_rejections_device_idx on scan_rejections(device_id, created_at desc);

create table device_requests (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users(id) on delete cascade,
  kind            text not null check (kind in ('rebind', 'reset')),
  from_device_id  uuid references devices(id) on delete set null,
  to_public_key   bytea check (to_public_key is null or length(to_public_key) = 32),
  to_device_info  jsonb,
  reason          text not null,
  status          text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'cancelled')),
  decided_by      uuid references users(id) on delete set null,
  decided_at      timestamptz,
  created_at      timestamptz not null default now()
);
create unique index device_requests_one_pending on device_requests(user_id) where status = 'pending';

-- Global kill switches / flags (managed from the Developer app).
create table system_flags (
  key         text primary key,
  enabled     boolean not null,
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
insert into system_flags(key, enabled) values ('scans_paused', false);

-- Append-only, hash-chained audit log: hash = SHA-256(prev_hash || canonical_json(entry)).
create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null,
  tenant_id   uuid,
  actor_type  text not null check (actor_type in ('user', 'system')),
  actor_id    uuid,
  action      text not null,
  subject     text,
  data        jsonb not null default '{}',
  prev_hash   bytea not null check (length(prev_hash) = 32),
  hash        bytea not null unique check (length(hash) = 32)
);
-- One hash chain per tenant (plus one for system-wide events), so tenants never wait on each other.
create index audit_log_tenant_chain on audit_log(tenant_id, id desc) where tenant_id is not null;
create index audit_log_global_chain on audit_log(id desc) where tenant_id is null;

create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_update before update or delete on audit_log
  for each row execute function audit_log_immutable();
