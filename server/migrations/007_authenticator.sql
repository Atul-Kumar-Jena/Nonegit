-- Sign-in with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).
-- The shared secret is stored encrypted (AES-256-GCM, key derived from the server pepper).
alter table users add column totp_secret_enc bytea;
alter table users add column totp_enabled_at timestamptz;
-- Highest 30-second step already used: a code can never be used twice.
alter table users add column totp_last_step bigint;
-- A secret being set up (confirmed with a first code before it replaces the old one).
alter table users add column totp_pending_enc bytea;
alter table users add column totp_pending_expires_at timestamptz;
alter table users add constraint users_totp_enabled check ((totp_secret_enc is null) = (totp_enabled_at is null));

-- How a sign-in challenge is answered.
alter table otp_challenges add column method text not null default 'email' check (method in ('email', 'authenticator'));
