-- Testing switch: nobody is stopped by phone binding (shared phones, phone switches, chip check).
insert into system_flags(key, enabled) values ('phone_rules_off', false) on conflict (key) do nothing;
