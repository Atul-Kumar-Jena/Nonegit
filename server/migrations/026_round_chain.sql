-- Layered scans, done properly:
--  • the number of scans is part of the schedule (weekly slot → every class it creates);
--  • every round has its own QR key (derived from the class secret), so codes can't cross rounds;
--  • a student's rounds form a hash chain: round k links to round k-1 (same phone, in order),
--    and the chain is re-verified before the attendance record is written.
alter table timetable_slots add column if not exists scan_rounds smallint not null default 1 check (scan_rounds between 1 and 5);

alter table scan_round_marks
  add column if not exists qr_seq integer,
  add column if not exists device_fingerprint text,
  add column if not exists chain bytea;

-- The chain head of a layered class is kept with the attendance record it produced.
alter table attendance_records add column if not exists round_chain bytea;
