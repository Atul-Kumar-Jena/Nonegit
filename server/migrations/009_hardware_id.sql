-- The physical phone behind a binding: a keyed hash of its hardware ID (Android ID / iOS vendor ID).
-- Clearing the app's data makes a new signing key but not a new phone, so a phone can't be
-- "re-registered" to a second student, and the same student on the same phone re-binds by itself.
alter table devices add column hw_hash bytea;
create index devices_hw_active_idx on devices(hw_hash) where status = 'active' and hw_hash is not null;
