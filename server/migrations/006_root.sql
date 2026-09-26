-- Developer console: more platform kill switches, per-institution feature flags, suspension reasons.
alter table system_flags add column reason text;
insert into system_flags(key, enabled) values
  ('sign_ins_paused', false),
  ('new_bindings_blocked', false),
  ('demo_login_off', false)
on conflict (key) do nothing;

create table tenant_flags (
  tenant_id   uuid not null references tenants(id) on delete cascade,
  key         text not null check (key in ('strict_geo', 'student_requests', 'manual_registers')),
  enabled     boolean not null,
  updated_by  uuid references users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, key)
);

alter table tenants add column status_reason text check (status_reason is null or length(status_reason) <= 300);
