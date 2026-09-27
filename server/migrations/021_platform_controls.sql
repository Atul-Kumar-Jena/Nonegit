-- Every platform kill switch has its row (the emergency hardware relaxation never had one, so it
-- couldn't be seen or flipped in the Developer app), plus the new "pause phone notifications".
insert into system_flags(key, enabled) values
  ('scans_paused', false),
  ('sign_ins_paused', false),
  ('new_bindings_blocked', false),
  ('demo_login_off', false),
  ('hardware_checks_relaxed', false),
  ('notifications_paused', false)
on conflict (key) do nothing;
