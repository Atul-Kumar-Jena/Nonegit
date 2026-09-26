/** Attendly design tokens — taken from the "Attendly · Mobile Prototype" design. */
export const colors = {
  bg: '#050814',
  bgRaised: '#080d1c',
  card: '#0b1122',
  cardHi: '#0f172b',
  border: '#1a2340',
  borderHi: '#26314f',
  text: '#e8ecf7',
  textMuted: '#8a94ad',
  textDim: '#5a6582',
  cyan: '#22d3ee',
  cyanSoft: 'rgba(34, 211, 238, 0.12)',
  cyanLine: 'rgba(34, 211, 238, 0.32)',
  blue: '#3b82f6',
  violet: '#8b5cf6',
  violetSoft: 'rgba(139, 92, 246, 0.14)',
  green: '#34d399',
  greenSoft: 'rgba(52, 211, 153, 0.12)',
  red: '#f87171',
  redSoft: 'rgba(248, 113, 113, 0.12)',
  amber: '#fbbf24',
  amberSoft: 'rgba(251, 191, 36, 0.12)',
  black: '#000000',
} as const;

export type Tone = 'cyan' | 'green' | 'violet' | 'red' | 'amber' | 'muted';

export const toneColor: Record<Tone, { fg: string; bg: string; line: string }> = {
  cyan: { fg: colors.cyan, bg: colors.cyanSoft, line: 'rgba(34, 211, 238, 0.30)' },
  green: { fg: colors.green, bg: colors.greenSoft, line: 'rgba(52, 211, 153, 0.30)' },
  violet: { fg: '#a78bfa', bg: colors.violetSoft, line: 'rgba(139, 92, 246, 0.32)' },
  red: { fg: colors.red, bg: colors.redSoft, line: 'rgba(248, 113, 113, 0.32)' },
  amber: { fg: colors.amber, bg: colors.amberSoft, line: 'rgba(251, 191, 36, 0.34)' },
  muted: { fg: colors.textMuted, bg: 'rgba(138, 148, 173, 0.10)', line: 'rgba(138, 148, 173, 0.22)' },
};

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export const radius = { sm: 10, md: 14, lg: 18, xl: 24, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export const gradients = {
  brand: ['#22d3ee', '#3b82f6'] as const,
  button: ['#2ee0f5', '#0fb5d8'] as const,
  avatar: ['#22d3ee', '#8b5cf6'] as const,
};
