-- Classes go live by themselves at their start time, and students see when the QR is on screen.
alter table class_sessions add column auto_started boolean not null default false;
-- Last time the professor's QR (phone or big screen) was on screen.
alter table class_sessions add column qr_shown_at timestamptz;
-- Students were told "attendance is being taken" (once per class).
alter table class_sessions add column taking_notified_at timestamptz;
create index class_sessions_clock_idx on class_sessions(status, scheduled_start) where status in ('scheduled', 'live');
