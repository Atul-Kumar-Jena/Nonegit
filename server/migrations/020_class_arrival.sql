-- A class has two moments: its time starts (logged by the class clock; the professor is reminded)
-- and the professor arrives and starts it (started_at, as before). A class whose time ran out
-- without the professor starting it is marked missed.
alter table class_sessions add column due_at timestamptz;
alter table class_sessions add column missed_at timestamptz;
create index class_sessions_due_idx on class_sessions(scheduled_start) where status = 'scheduled';
