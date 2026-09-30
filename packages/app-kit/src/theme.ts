/**
 * Attendly design tokens — "ink & paper": a deep ink canvas, layered surfaces lit from the top,
 * white as the one accent (selected = filled white), colour only for status. Plus Jakarta Sans
 * for everything you read, Fraunces for headlines and big figures, JetBrains Mono for codes & times.
 */
export const colors = {
  bg: '#0a0a0d',
  bgRaised: '#101014',
  card: '#141418',
  cardHi: '#1b1b21',
  border: '#24242b',
  borderHi: '#35353e',
  /** The lit top edge of every surface. */
  edge: 'rgba(255, 255, 255, 0.10)',
  text: '#f7f7f8',
  textMuted: '#a5a5ae',
  textDim: '#6c6c77',
  /** The accent is white: selected things are filled white with ink text. */
  cyan: '#ffffff',
  cyanSoft: 'rgba(255, 255, 255, 0.08)',
  cyanLine: 'rgba(255, 255, 255, 0.28)',
  blue: '#d4d4d8',
  violet: '#e4e4e7',
  violetSoft: 'rgba(255, 255, 255, 0.06)',
  green: '#4ade80',
  greenSoft: 'rgba(74, 222, 128, 0.10)',
  red: '#f87171',
  redSoft: 'rgba(248, 113, 113, 0.10)',
  amber: '#fbbf24',
  amberSoft: 'rgba(251, 191, 36, 0.10)',
  black: '#000000',
  /** Text on a white (selected / primary) surface. */
  ink: '#0a0a0d',
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
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  /** Headlines and big figures. */
  display: 'Fraunces_600SemiBold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export const radius = { sm: 10, md: 14, lg: 20, xl: 26, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export const gradients = {
  brand: ['#ffffff', '#d9d9de'] as const,
  button: ['#ffffff', '#e6e6ea'] as const,
  avatar: ['#f4f4f5', '#a1a1aa'] as const,
  /** A card's lit top edge: bright in the middle, fading to the corners. */
  edge: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.16)', 'rgba(255,255,255,0)'] as const,
};

/** Soft depth under raised surfaces (iOS shadow; Android elevation stays flat to keep dark cards clean). */
export const shadow = {
  shadowColor: '#000',
  shadowOpacity: 0.35,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
} as const;
