-- Professors (role 'teacher') can be granted extra powers by an admin, one by one:
--   people  · add / edit students and professors, paste lists, unbind phones
--   courses · all courses, enrolments, the weekly timetable and rooms
--   planner · the drag-and-drop planner, publishing changes, handing classes to others
--   devices · phone-switch requests and suspicious scans
-- Admins (principal / HOD) have all of them, plus institution settings and managing roles.
alter table users add column permissions text[] not null default '{}'
  check (permissions <@ array['people', 'courses', 'planner', 'devices']::text[]);
