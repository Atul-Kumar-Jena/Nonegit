-- The developer's own setup code is also kept encrypted (not only hashed), so the server prints the
-- same code at every restart until it is used — free hosting restarts often.
alter table users add column setup_code_enc bytea;
