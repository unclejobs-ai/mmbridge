// Shared formatting and counting utilities for TUI views.

export interface SeverityCounts {
  critical: number;
  warning: number;
  info: number;
  refactor: number;
}

/** "2h ago", "3d ago", "just now" — safe on malformed ISO strings. */
export function formatRelativeTime(iso: string): string {
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return '';
  }
}

/** Format ISO date to compact "MM-DD HH:mm" display. */
export function formatCompactDate(iso: string): string {
  try {
    const d = new Date(iso);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hour = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hour}:${min}`;
  } catch {
    return iso.slice(0, 16);
  }
}

/** Replace $HOME prefix with ~ */
export function shortenPath(p: string): string {
  const home = process.env.HOME ?? '';
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

/** Truncate string with ellipsis */
export function truncate(s: string, max: number): string {
  if (max <= 1) return s.length > 0 ? '…' : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Reverse array (returns copy) */
export function reversedCounts(counts: number[]): number[] {
  return [...counts].reverse();
}

/** Average per day as formatted string */
export function avgPerDay(counts: number[]): string {
  if (counts.length === 0) return '0.0';
  const total = counts.reduce((a, b) => a + b, 0);
  return (total / counts.length).toFixed(1);
}

/** Bucket findings by severity. Accepts any object with a `severity` string field. */
export function countBySeverity(findings: ReadonlyArray<{ severity?: string }>): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0, refactor: 0 };
  for (const f of findings) {
    const sev = (f.severity ?? 'INFO').toUpperCase();
    if (sev === 'CRITICAL') counts.critical++;
    else if (sev === 'WARNING') counts.warning++;
    else if (sev === 'REFACTOR') counts.refactor++;
    else counts.info++;
  }
  return counts;
}
