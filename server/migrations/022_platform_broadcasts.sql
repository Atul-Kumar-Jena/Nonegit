-- Broadcasts from Attendly (the Developer app): a notice in each chosen institution, to everyone,
-- students, admins or all faculty. One broadcast_id ties the copies together.
alter table notices drop constraint if exists notices_audience_check;
alter table notices add constraint notices_audience_check check (audience in ('everyone', 'students', 'staff', 'admins', 'batches', 'courses'));
alter table notices add column platform boolean not null default false;
alter table notices add column author_label text;
alter table notices add column broadcast_id uuid;
create index notices_broadcast_idx on notices(broadcast_id) where broadcast_id is not null;
