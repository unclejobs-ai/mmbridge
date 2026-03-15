// Design tokens — Catppuccin Mocha palette
// https://catppuccin.com/palette
import { ADAPTER_NAMES } from '@mmbridge/core';
export type { AdapterName } from '@mmbridge/core';
export { ADAPTER_NAMES };

export const colors = {
  // Background layers (dark → light)
  crust: '#11111B',
  mantle: '#181825',
  base: '#1E1E2E',
  surface0: '#313244',
  surface1: '#45475A',
  surface2: '#585B70',

  // Text layers (dim → bright)
  overlay0: '#6C7086',
  overlay1: '#7F849C',
  overlay2: '#9399B2',
  subtext0: '#A6ADC8',
  subtext1: '#BAC2DE',
  text: '#CDD6F4',

  // Accents
  accent: '#B4BEFE', // Lavender
  accentAlt: '#F5C2E7', // Pink

  // Severity
  red: '#F38BA8', // Red
  yellow: '#F9E2AF', // Yellow
  sky: '#89DCEB', // Sky
  peach: '#FAB387', // Peach
  green: '#A6E3A1', // Green
  blue: '#89B4FA', // Blue
  teal: '#94E2D5', // Teal
  mauve: '#CBA6F7', // Mauve
  sapphire: '#74C7EC', // Sapphire
  cyan: '#89DCEB', // Alias for sky

  // Semantic aliases
  bg: '#1E1E2E', // Alias for base (dark background)
  border: '#313244', // Alias for surface0 (panel borders)
  textMuted: '#A6ADC8', // Alias for subtext0 (muted labels)
  textDim: '#6C7086', // Alias for overlay0 (dimmed text)
} as const;

// Each adapter gets its own unique color
export const toolColors: Record<string, string> = {
  kimi: colors.teal,
  qwen: colors.mauve,
  codex: colors.blue,
  gemini: colors.sapphire,
  droid: colors.accentAlt,
  claude: colors.peach,
};

export function toolColor(name: string): string {
  return toolColors[name.toLowerCase()] ?? colors.overlay2;
}

// Severity symbols and colors
export const SEVERITY_ICONS: Record<string, string> = {
  CRITICAL: '◆',
  WARNING: '▲',
  INFO: '●',
  REFACTOR: '◇',
};

export function severityColor(severity: string): string {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return colors.red;
    case 'WARNING':
      return colors.yellow;
    case 'INFO':
      return colors.sky;
    case 'REFACTOR':
      return colors.peach;
    default:
      return colors.text;
  }
}

export function severityIcon(severity: string): string {
  return SEVERITY_ICONS[severity.toUpperCase()] ?? '●';
}

// Status colors
export function statusColor(status: 'success' | 'error' | 'warning' | 'info'): string {
  switch (status) {
    case 'success':
      return colors.green;
    case 'error':
      return colors.red;
    case 'warning':
      return colors.yellow;
    case 'info':
      return colors.sky;
  }
}

// Visual characters
export const CHARS = {
  selected: '❯',
  installed: '✓',
  missing: '✗',
  radioOn: '◉',
  radioOff: '○',
  collapsed: '▶',
  expanded: '▼',
  followup: '↩',
  hrule: '─',
  sparkBlocks: '▁▂▃▄▅▆▇█',
  progressFull: '█',
  progressEmpty: '░',
} as const;
