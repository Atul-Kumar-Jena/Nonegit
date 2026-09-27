-- Institutions added by the demo (sandbox) developer while testing. The sandbox developer sees the
-- demo institute plus these, never a real institution; a real developer sees everything.
alter table tenants add column sandbox boolean not null default false;
