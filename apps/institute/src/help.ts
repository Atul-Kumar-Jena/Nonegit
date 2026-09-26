/** Short explanations behind the ⓘ buttons. Plain words, one idea per line. */
export const HELP: Record<string, { title: string; text: string[] }> = {
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
    title: 'Who’s busy where',
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
    text: ['A batch is a section, e.g. “CSE · Sem 6 · A”.', 'Add students and pick its courses: everyone in the batch is enrolled in those courses automatically, and leaves them when removed.'],
  },
  rooms: {
    title: 'Rooms',
    text: ['Stand in the room and tap “Use my location”. QR scans are accepted only from inside the room’s circle (radius).'],
  },
  people: {
    title: 'People',
    text: ['Add students and teachers one by one or paste a list from a spreadsheet.', 'Open a person to see their phone, reset it, set up Google Authenticator for them, or suspend the account.'],
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
