// ANSI color constants for the TUI
export const colors = {
  bg: '#0F172A',
  surface: '#1E293B',
  borderIdle: '#334155',
  borderFocus: '#22C55E',
  text: '#F8FAFC',
  textMuted: '#94A3B8',
  green: '#22C55E',
  yellow: '#EAB308',
  red: '#EF4444',
  cyan: '#06B6D4',
  dim: '#64748B',
} as const;

// Severity → color mapping
export function severityColor(severity: string): string {
  switch (severity.toUpperCase()) {
    case 'CRITICAL': return colors.red;
    case 'WARNING': return colors.yellow;
    case 'INFO': return colors.cyan;
    case 'REFACTOR': return colors.dim;
    default: return colors.text;
  }
}
