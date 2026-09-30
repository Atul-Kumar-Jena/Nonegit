-- Data lifecycle: every clean-up rule (src/lib/retention.ts) finds its rows through an index,
-- so trimming a big table never scans it whole.
create index if not exists notifications_created on notifications(created_at);
create index if not exists scan_rejections_reviewed_created on scan_rejections(created_at) where review_status <> 'open';
create index if not exists client_actions_created on client_actions(created_at);
create index if not exists device_online_minute on device_online(minute);
create index if not exists attest_challenges_expiry on attest_challenges(expires_at);
create index if not exists otp_challenges_created on otp_challenges(created_at);
create index if not exists auth_tickets_expiry on auth_tickets(expires_at);
create index if not exists auth_sessions_refresh_expiry on auth_sessions(refresh_expires_at);
create index if not exists auth_sessions_rotated on auth_sessions(rotated_at) where rotated_at is not null;
create index if not exists auth_sessions_revoked on auth_sessions(revoked_at) where revoked_at is not null;
-- Deleting an old login row clears its children's parent link: without this each delete scanned the table.
create index if not exists auth_sessions_parent on auth_sessions(parent_id) where parent_id is not null;
create index if not exists push_tokens_updated on push_tokens(updated_at);
create index if not exists scan_round_marks_marked on scan_round_marks(marked_at);
create index if not exists change_requests_decided_created on change_requests(created_at) where status <> 'pending';
create index if not exists device_requests_decided_created on device_requests(created_at) where status <> 'pending';
create index if not exists notices_deleted on notices(deleted_at) where deleted_at is not null;
create index if not exists timetable_drafts_done on timetable_drafts(updated_at) where status <> 'draft';

-- The same index twice only doubles the cost of every write: keep one of each pair.
drop index if exists notifications_user_recent;          -- = notifications_user_idx (user_id, id desc)
drop index if exists scan_rejections_device_recent;      -- = scan_rejections_device_idx (device_id, created_at desc)
