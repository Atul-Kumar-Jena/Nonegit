-- Onboarding: every institution has a unique code (typed once in the Institute app) and a
-- verified mark set by an Attendly developer. Institutions that already exist are verified;
-- ones a developer creates from now on start unverified (no one can sign in until verified).
alter table tenants add column code text;
update tenants set code = case when slug = 'demo' then 'DEMO2026' else upper(substr(md5(id::text || clock_timestamp()::text), 1, 8)) end;
alter table tenants alter column code set not null;
alter table tenants alter column code set default upper(substr(md5(gen_random_uuid()::text), 1, 8));
alter table tenants add constraint tenants_code_format check (code ~ '^[A-Z0-9]{8}$');
create unique index tenants_code_key on tenants(code);

alter table tenants add column verified_at timestamptz default now();
alter table tenants add column verified_by uuid references users(id) on delete set null;
