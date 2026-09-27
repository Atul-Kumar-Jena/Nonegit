import { weekdayOf, type DraftOp, type PlannerCourse } from '@attendly/protocol';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "14:30" → "2:30 PM". */
const h12 = (hm: string) => {
  const [h = 0, m = 0] = hm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const when = (date: string, start: string) => `${DAY[weekdayOf(date)]} ${Number(date.slice(8))}/${Number(date.slice(5, 7))} ${h12(start)}`;

export interface KnownSession {
  courseId: string;
  date: string;
  start: string;
}

/** Plain-language summary of one draft change, e.g. "CS-101 · Tue 30/9 10:00 → Wed 1/10 14:00 (this date only)". */
export function describeOp(
  o: DraftOp,
  ctx: { courses: Map<string, PlannerCourse>; sessions: Map<string, KnownSession>; slots: Map<string, { courseId: string; weekday: number; start: string }>; teachers: Map<string, string>; rooms: Map<string, string> },
): string {
  const code = (id: string | undefined) => (id ? (ctx.courses.get(id)?.code ?? 'a course') : 'a class');
  const room = (id: string | null | undefined) => (id ? ` · ${ctx.rooms.get(id) ?? 'room'}` : '');
  switch (o.op) {
    case 'reschedule': {
      const s = ctx.sessions.get(o.sessionId);
      return `${code(s?.courseId)} · ${s ? when(s.date, s.start) : 'class'} → ${when(o.date, o.start)}–${h12(o.end)}${room(o.roomId)} (this date only)`;
    }
    case 'cancel': {
      const s = ctx.sessions.get(o.sessionId);
      return `${code(s?.courseId)} · ${s ? when(s.date, s.start) : 'class'} cancelled — ${o.reason}`;
    }
    case 'substitute': {
      const s = ctx.sessions.get(o.sessionId);
      return `${code(s?.courseId)} · ${s ? when(s.date, s.start) : 'class'} taken by ${o.teacherId ? (ctx.teachers.get(o.teacherId) ?? 'another teacher') : 'its own teacher again'}`;
    }
    case 'extra':
      return `Extra ${code(o.courseId)} · ${when(o.date, o.start)}–${h12(o.end)}${room(o.roomId)}${o.teacherId ? ` · by ${ctx.teachers.get(o.teacherId) ?? 'another teacher'}` : ''}`;
    case 'slot.update': {
      const s = ctx.slots.get(o.slotId);
      return `${code(o.courseId ?? s?.courseId)} weekly · ${s ? `every ${DAY_LONG[s.weekday]} ${h12(s.start)}` : 'slot'} → every ${DAY_LONG[o.weekday]} ${h12(o.start)}–${h12(o.end)}${room(o.roomId)}`;
    }
    case 'slot.create':
      return `New weekly ${code(o.courseId)} · every ${DAY_LONG[o.weekday]} ${h12(o.start)}–${h12(o.end)}${room(o.roomId)}`;
    case 'slot.delete': {
      const s = ctx.slots.get(o.slotId);
      return `Remove ${code(s?.courseId)} weekly class${s ? ` (every ${DAY_LONG[s.weekday]} ${h12(s.start)})` : ''}`;
    }
  }
}
