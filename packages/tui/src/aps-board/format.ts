export function formatAge(since: string | null, readAt: string): string {
  if (!since) return '—';
  const milliseconds = Date.parse(readAt) - Date.parse(since);
  if (!Number.isFinite(milliseconds)) return '—';
  const minutes = Math.floor(Math.max(0, milliseconds) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

export function formatCost(usd: number | null): string {
  return usd === null ? 'unknown' : `≈$${usd.toFixed(2)} list-equiv`;
}

export function formatTokens(tokens: number | null): string {
  return tokens === null ? 'unknown' : tokens.toLocaleString('en-US');
}

// Terminal cells, rather than JS string length: Korean headings occupy two cells.
function cellWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0) || /\p{Mark}/u.test(character)) return 0;
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x1f300)
    ? 2
    : 1;
}

export function fitCell(text: string, width: number): string {
  if (width <= 0) return '';
  const total = [...text].reduce((sum, character) => sum + cellWidth(character), 0);
  if (total <= width) return text + ' '.repeat(width - total);
  let result = '';
  let used = 0;
  for (const character of text) {
    const size = cellWidth(character);
    if (used + size > width - 1) break;
    result += character;
    used += size;
  }
  return `${result}…${' '.repeat(width - used - 1)}`;
}

export function visibleWindow(length: number, selected: number, capacity: number): { start: number; end: number } {
  const size = Math.max(1, Math.floor(capacity));
  const start = Math.max(0, Math.min(selected - Math.floor(size / 2), length - size));
  return { start, end: Math.min(length, start + size) };
}

export function wrapLines(lines: string[], width: number): string[] {
  const result: string[] = [];
  const columns = Math.max(2, width);
  for (const text of lines) {
    for (const line of text.replaceAll('\r', '').split('\n')) {
      let part = '';
      let used = 0;
      for (const character of line) {
        const size = cellWidth(character);
        if (used + size > columns) {
          result.push(part);
          part = '';
          used = 0;
        }
        part += character;
        used += size;
      }
      result.push(part);
    }
  }
  return result;
}

export const migrationHint = 'needs migration NNNN_worker_runs (run ledger unavailable)';
