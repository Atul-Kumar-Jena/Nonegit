import { z } from 'zod';

/**
 * Notice centre: broadcasts from admins and professors to everyone, all students, all faculty,
 * chosen batches or chosen subjects — delivered as a notification at once, read in the Notice
 * centre, formatted (see richtext.ts), with emoji reactions and "seen by".
 */
const uuid = z.uuid();

export const NOTICE_REACTIONS = ['👍', '❤️', '🎉', '😂', '😮', '🙏'] as const;
export const NoticeReaction = z.enum(NOTICE_REACTIONS);
export type NoticeReaction = z.infer<typeof NoticeReaction>;

export const NoticeCategory = z.enum(['general', 'academic', 'exam', 'event', 'holiday']);
export type NoticeCategory = z.infer<typeof NoticeCategory>;
export const NOTICE_CATEGORIES: readonly { key: NoticeCategory; label: string; emoji: string }[] = [
  { key: 'general', label: 'General', emoji: '📢' },
  { key: 'academic', label: 'Academic', emoji: '📚' },
  { key: 'exam', label: 'Exam', emoji: '📝' },
  { key: 'event', label: 'Event', emoji: '🎉' },
  { key: 'holiday', label: 'Holiday', emoji: '🌴' },
];

/** Who a notice is for. */
export const NoticeAudience = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('everyone') }),
  z.object({ kind: z.literal('students') }),
  z.object({ kind: z.literal('staff') }),
  z.object({ kind: z.literal('batches'), batchIds: z.array(uuid).min(1).max(50) }),
  z.object({ kind: z.literal('courses'), courseIds: z.array(uuid).min(1).max(50) }),
]);
export type NoticeAudience = z.infer<typeof NoticeAudience>;

export const NoticeBody = z.object({
  title: z.string().trim().min(1, 'Add a title').max(120),
  body: z.string().trim().min(1, 'Write the notice').max(5000),
  category: NoticeCategory.default('general'),
  audience: NoticeAudience,
  pinned: z.boolean().default(false),
  /** Shown in red, and the notification says "Important". */
  important: z.boolean().default(false),
});
export type NoticeBody = z.infer<typeof NoticeBody>;

export const NoticeUpdateBody = NoticeBody.omit({ audience: true }).partial();
export type NoticeUpdateBody = z.infer<typeof NoticeUpdateBody>;

export const NoticeSummary = z.object({
  id: uuid,
  title: z.string(),
  /** Plain-text preview. */
  preview: z.string(),
  category: NoticeCategory,
  pinned: z.boolean(),
  important: z.boolean(),
  author: z.object({ id: uuid, name: z.string(), role: z.string() }),
  /** "Everyone", "All students", "CSE-5A, CSE-5B", "CS-301"… */
  audienceLabel: z.string(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  read: z.boolean(),
  reactions: z.array(z.object({ emoji: NoticeReaction, count: z.number().int(), mine: z.boolean() })),
  /** Author or admin: may edit / delete; and sees "seen by". */
  canEdit: z.boolean(),
});
export type NoticeSummary = z.infer<typeof NoticeSummary>;

export const NoticeDetail = NoticeSummary.extend({
  body: z.string(),
  audience: NoticeAudience,
  /** Only for the author and admins. */
  stats: z.object({ recipients: z.number().int(), seen: z.number().int() }).nullable(),
});
export type NoticeDetail = z.infer<typeof NoticeDetail>;

export const NoticesResponse = z.object({
  /** Pinned notices (first page only, filter "all"). */
  pinned: z.array(NoticeSummary).default([]),
  items: z.array(NoticeSummary),
  unread: z.number().int(),
  nextBefore: z.string().nullable(),
});
export type NoticesResponse = z.infer<typeof NoticesResponse>;

export const NoticesQuery = z.object({
  filter: z.enum(['all', 'unread', 'pinned', 'mine']).default('all'),
  category: NoticeCategory.optional(),
  /** Paging: createdAt of the last item seen. */
  before: z.string().datetime().optional(),
});

export const ReactBody = z.object({ emoji: NoticeReaction });
export const AudienceCountResponse = z.object({ recipients: z.number().int(), label: z.string() });
export type AudienceCountResponse = z.infer<typeof AudienceCountResponse>;
