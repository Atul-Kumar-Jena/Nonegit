-- Big-screen pairing: a laptop / smartboard shows a one-time code, the teacher
-- approves it from the Institute app, and that screen then displays one live
-- class's rotating QR. The screen never receives the class's QR secret.
create table present_pairings (
  id           uuid primary key default gen_random_uuid(),
  code_hash    bytea not null unique,       -- HMAC(pepper, code): the code is never stored
  secret_hash  bytea not null,              -- sha256 of the screen's bearer secret
  user_agent   text,
  ip           text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,        -- pairing window (5 min) until approved
  tenant_id    uuid references tenants(id) on delete cascade,
  session_id   uuid references class_sessions(id) on delete cascade,
  approved_by  uuid references users(id),
  approved_at  timestamptz,
  revoked_at   timestamptz,
  revoked_by   uuid references users(id),
  check ((session_id is null) = (approved_at is null))
);
create index present_pairings_session on present_pairings(session_id) where session_id is not null;
create index present_pairings_expiry on present_pairings(expires_at);
