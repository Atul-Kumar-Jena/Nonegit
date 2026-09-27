-- Notice centre: broadcasts to everyone / all students / all faculty / batches / subjects,
-- with read receipts and emoji reactions. A new grantable permission lets a professor send
-- institution-wide notices.
alter table users drop constraint if exists users_permissions_check;
alter table users add constraint users_permissions_check
  check (permissions <@ array['people', 'courses', 'planner', 'devices', 'broadcast']::text[]);

create table notices (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  author_id       uuid references users(id) on delete set null,
  title           text not null check (length(title) between 1 and 120),
  body            text not null check (length(body) between 1 and 5000),
  category        text not null default 'general' check (category in ('general', 'academic', 'exam', 'event', 'holiday')),
  audience        text not null check (audience in ('everyone', 'students', 'staff', 'batches', 'courses')),
  batch_ids       uuid[] not null default '{}',
  course_ids      uuid[] not null default '{}',
  audience_label  text not null,
  pinned          boolean not null default false,
  important       boolean not null default false,
  recipients      int not null default 0,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz
);
create index notices_tenant_idx on notices(tenant_id, created_at desc) where deleted_at is null;
create index notices_batches_idx on notices using gin(batch_ids);
create index notices_courses_idx on notices using gin(course_ids);

create table notice_reads (
  notice_id  uuid not null references notices(id) on delete cascade,
  user_id    uuid not null references users(id) on delete cascade,
  read_at    timestamptz not null default now(),
  primary key (notice_id, user_id)
);

create table notice_reactions (
  notice_id   uuid not null references notices(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  emoji       text not null check (emoji in ('👍', '❤️', '🎉', '😂', '😮', '🙏')),
  created_at  timestamptz not null default now(),
  primary key (notice_id, user_id, emoji)
);
