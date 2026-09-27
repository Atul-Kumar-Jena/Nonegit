/** Short explanations behind the ⓘ buttons. Plain words, one idea per line. */
export const HELP: Record<string, { title: string; text: string[] }> = {
  notices: {
    title: 'Notices',
    text: [
      'Send to: a batch or your subjects (any professor), or everyone / all students / all faculty (admins, and professors an admin gave “Notices to everyone”).',
      'Everyone it’s for gets a notification at once; tapping it opens the notice. They can react with emojis; you see how many have seen it.',
      'Formatting: select words and tap B (bold), I (italic) or S (strike). Heading, bullet, numbered list and quote buttons act on the current line. Link wraps the selection. Preview shows exactly how it will look.',
      'Pin keeps it on top of everyone’s Notice centre; Important highlights it in red. You (or an admin) can edit or delete it later.',
    ],
  },
  reports: {
    title: 'Attendance reports',
    text: [
      'Pick a batch (or all students), then a subject (or all subjects). You see every student’s %; red = below the minimum.',
      'Tap a student to open their attendance subject by subject, with every class.',
      'Download this view as a PDF (to print or send) or an Excel sheet. “All subjects” gives each student’s % per subject plus their cumulative total.',
      'Every teacher can view and download any batch or student. Without internet the file uses the latest copy saved on this phone.',
    ],
  },
  studentReport: {
    title: 'A student’s attendance',
    text: [
      'Their overall % this term and each subject’s % (attended / held).',
      'Tap a subject to see every class: date, time, present or absent, and how it was marked.',
      'Download all subjects (with the cumulative total), or one subject class by class, as PDF or Excel.',
    ],
  },
  cover: {
    title: 'Cover a class',
    text: [
      'Teachers are listed with where they are: green = free, amber = has a class then.',
      'Long-press a teacher and drop them on a class (or tap a teacher, then a class). Add a note for them and one for the students, then Send.',
      'Nothing changes until the teacher accepts on their phone. Then the class becomes theirs and its students get a notification with your note.',
      'Only admins (principal / HOD) can hand classes out. Teachers accept or decline.',
    ],
  },
  inbox: {
    title: 'Requests',
    text: [
      'For me: classes your admin asks you to take, and questions from your students. Accept or decline with an optional reply.',
      'Sent by me: what you asked, and the answers.',
      'Every answer is sent as a notification, and saved for 30 days.',
    ],
  },
  planner: {
    title: 'Timetable planner',
    text: [
      'A week of every class. Long-press a class and drag it to another day or time; drop it on another class to swap them.',
      'Drag a course from the tray to add an extra class. Tap a class to change its room or teacher, or cancel it.',
      'Changes stay in a draft (red outline = clash). Review & publish applies them all at once and notifies exactly the students affected. Giving a class to another teacher sends them a request first.',
    ],
  },
  busy: {
    title: 'Who’s free',
    text: ['Every teacher’s and room’s classes for a day, on a timeline.', 'Use “Free at” to find who can take a class at a given time.'],
  },
  register: {
    title: 'Register',
    text: [
      'Tap who’s absent (everyone starts present) — or switch to “Tap who’s present”.',
      'Students who already scanned the QR are marked “Scanned”. Removing one needs a short reason.',
      'Tick “I have checked every name”, then Save. It works offline and uploads later.',
    ],
  },
  batches: {
    title: 'Batches',
    text: [
      'Everything is organised by batch: Semester → batch (e.g. CSE-5A) → its students → its subjects.',
      'Any teacher can create a batch, add students (pick registered ones or paste a whole list) and add subjects (existing ones, or a new one they will teach).',
      'Students in a batch get its semester and are enrolled in all its subjects automatically — new students too.',
      'Removing students or subjects, renaming, archiving or moving to the next semester: an admin or the teacher who created the batch.',
    ],
  },
  batch: {
    title: 'A batch',
    text: [
      'Students: tap anyone to see their attendance in every subject. “Add students” finds registered students; “Paste a list” adds a class from a spreadsheet (already-registered students are just added).',
      'Subjects: every student of the batch takes these. Add an existing subject or create a new one (you become its teacher). Then give it weekly slots in Timetable.',
      'Settings: semester (moving the batch up moves all its students), name, department, archive.',
      'Attendance: the whole batch’s report — per subject or cumulative — as PDF or Excel.',
    ],
  },
  rooms: {
    title: 'Rooms',
    text: ['Stand in the room and tap “Use my location”. QR scans are accepted only from inside the room’s circle (radius).'],
  },
  people: {
    title: 'People & roles',
    text: [
      'Admin (principal / HOD): everything, including institution settings and who may do what. Professor: their own classes, batches and all attendance reports.',
      'An admin can give a professor extra powers — People, Courses & timetable, Planner & cover, Phones & scans — or make them an admin: open the professor → Role & permissions.',
      'Add students and professors one by one or paste a list. Open a person to see their phone, reset it, set up Google Authenticator, or suspend the account.',
      'An institution always keeps at least one admin.',
    ],
  },
  flags: {
    title: 'Suspicious scans',
    text: ['Scans the server refused that look like cheating: fake GPS, another person’s phone, a replayed code.', 'Accept one if it was genuine, or block it.'],
  },
  phoneRequests: {
    title: 'Phone requests',
    text: ['Each person can use one phone. When someone changes phones, they ask here; approve it to move their account to the new phone.'],
  },
  more: {
    title: 'Roles',
    text: [
      'Admin (principal / HOD): sets up the institution, plans and publishes timetable changes for any batch, hands classes to free teachers, approves phone changes and reviews suspicious scans.',
      'Teacher: runs their classes (QR code, big screen or register), moves or cancels their own classes, accepts or declines classes they are asked to take, and answers students.',
      'Student: scans the class QR, sees attendance and the timetable, and can ask a teacher about a class.',
    ],
  },
  today: {
    title: 'Today',
    text: ['Your classes today and what’s coming up. Tap a class to start it with a QR code, show it on a big screen, or take a register.', 'Requests waiting for you appear at the top.'],
  },
};
