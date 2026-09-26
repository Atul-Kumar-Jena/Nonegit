/** Attendly design tokens: monochrome (black, white, greys), colour only for status. */
export const colors = {
  bg: '#0a0a0a',
  bgRaised: '#121212',
  card: '#141414',
  cardHi: '#1b1b1b',
  border: '#262626',
  borderHi: '#3a3a3a',
  text: '#fafafa',
  textMuted: '#a3a3a3',
  textDim: '#6b6b6b',
  /** The accent is white: black & white, like attendly's site. */
  cyan: '#ffffff',
  cyanSoft: 'rgba(255, 255, 255, 0.08)',
  cyanLine: 'rgba(255, 255, 255, 0.28)',
  blue: '#d4d4d4',
  violet: '#e5e5e5',
  violetSoft: 'rgba(255, 255, 255, 0.06)',
  green: '#4ade80',
  greenSoft: 'rgba(74, 222, 128, 0.10)',
  red: '#f87171',
  redSoft: 'rgba(248, 113, 113, 0.10)',
  amber: '#fbbf24',
  amberSoft: 'rgba(251, 191, 36, 0.10)',
  black: '#000000',
} as const;

export type Tone = 'cyan' | 'green' | 'violet' | 'red' | 'amber' | 'muted';

export const toneColor: Record<Tone, { fg: string; bg: string; line: string }> = {
  cyan: { fg: colors.text, bg: 'rgba(255, 255, 255, 0.06)', line: 'rgba(255, 255, 255, 0.22)' },
  green: { fg: colors.green, bg: colors.greenSoft, line: 'rgba(74, 222, 128, 0.30)' },
  violet: { fg: colors.text, bg: 'rgba(255, 255, 255, 0.06)', line: 'rgba(255, 255, 255, 0.30)' },
  red: { fg: colors.red, bg: colors.redSoft, line: 'rgba(248, 113, 113, 0.32)' },
  amber: { fg: colors.amber, bg: colors.amberSoft, line: 'rgba(251, 191, 36, 0.32)' },
  muted: { fg: colors.textMuted, bg: 'rgba(255, 255, 255, 0.04)', line: 'rgba(255, 255, 255, 0.14)' },
};

export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export const radius = { sm: 10, md: 14, lg: 20, xl: 26, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export const gradients = {
  brand: ['#ffffff', '#cfcfcf'] as const,
  button: ['#ffffff', '#ececec'] as const,
  avatar: ['#f5f5f5', '#9a9a9a'] as const,
};
