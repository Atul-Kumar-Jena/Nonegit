-- Minutes in which each phone talked to the server (outside of scanning): an "offline" scan
-- uploaded long after the phone was demonstrably online again is a forwarded / old QR code.
create table device_online (
  device_id uuid not null references devices(id) on delete cascade,
  minute    timestamptz not null,
  primary key (device_id, minute)
);

-- Each batch has a mentor (a professor): device requests of its students go to them.
alter table batches add column mentor_id uuid references users(id) on delete set null;
create index batches_mentor_idx on batches(mentor_id) where mentor_id is not null;

-- Institutions may refuse offline scans altogether.
alter table tenant_flags drop constraint if exists tenant_flags_key_check;
alter table tenant_flags add constraint tenant_flags_key_check
  check (key in ('strict_geo', 'student_requests', 'manual_registers', 'hardware_binding', 'offline_scans_off'));
