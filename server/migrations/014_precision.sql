-- Hardware-backed phone binding (Android key attestation) and precise geofencing.

-- The phone's P-256 key living in its TEE / StrongBox, proven by a Google-rooted attestation.
-- Once set, the phone itself can never replace it: only a new binding (or an admin-approved switch).
alter table devices add column hw_key_spki bytea;
alter table devices add column attest_level text check (attest_level in ('tee', 'strongbox'));
alter table devices add column attested_at timestamptz;
alter table devices add column attest_patch int;
-- Set when Google's attestation proved this phone rooted / unlocked / running a clone app: its marks are refused.
alter table devices add column attest_failure text;

-- A new phone waiting for admin approval carries its already-verified hardware key.
alter table device_requests add column to_hw_key_spki bytea;
alter table device_requests add column to_attest_level text check (to_attest_level in ('tee', 'strongbox'));
alter table device_requests add column to_attest_patch int;

-- One-time challenge for phones bound before hardware keys existed (single use, short-lived).
create table attest_challenges (
  device_id  uuid primary key references devices(id) on delete cascade,
  challenge  bytea not null check (length(challenge) = 32),
  expires_at timestamptz not null
);

-- How precisely the classroom's centre was measured (averaged GPS fixes), in metres.
alter table rooms add column center_accuracy_m real check (center_accuracy_m is null or center_accuracy_m between 0 and 1000);
alter table class_sessions add column center_accuracy_m real check (center_accuracy_m is null or center_accuracy_m between 0 and 1000);

-- Evidence on each mark: signed inside the secure chip, and how many GPS samples backed it.
alter table attendance_records add column hw_signed boolean not null default false;
alter table attendance_records add column gps_samples smallint;
create index attendance_records_user_time_idx on attendance_records(user_id, marked_at desc);

-- Institutions may require secure-hardware phones.
alter table tenant_flags drop constraint if exists tenant_flags_key_check;
alter table tenant_flags add constraint tenant_flags_key_check check (key in ('strict_geo', 'student_requests', 'manual_registers', 'hardware_binding'));
