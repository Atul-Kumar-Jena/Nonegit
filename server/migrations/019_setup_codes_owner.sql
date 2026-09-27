-- First sign-in without email: a one-time setup code links Google Authenticator. Stored only as
-- a keyed hash; wrong guesses are counted and burn the code.
alter table users add column setup_code_hash bytea;
alter table users add column setup_code_expires_at timestamptz;
alter table users add column setup_code_attempts int not null default 0;

-- The main admin of each institution (made by Attendly with the institution): the only one who
-- adds, changes or removes other admins. At most one per institution.
alter table users add column is_owner boolean not null default false;
create unique index users_one_owner on users(tenant_id) where is_owner;
update users u set is_owner = true
  where u.id in (select distinct on (tenant_id) id from users where role = 'admin' and status = 'active' order by tenant_id, created_at, id);
