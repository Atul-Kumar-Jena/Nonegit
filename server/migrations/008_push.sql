-- Instant phone notifications (Firebase Cloud Messaging), one token per bound phone.
create table push_tokens (
  device_id   uuid primary key references devices(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  token       text not null check (length(token) between 10 and 4096),
  platform    text not null check (platform in ('android', 'ios')),
  updated_at  timestamptz not null default now()
);
create index push_tokens_user_idx on push_tokens(user_id);
alter table notifications add column pushed_at timestamptz;
create index notifications_unpushed_idx on notifications(created_at) where pushed_at is null;
