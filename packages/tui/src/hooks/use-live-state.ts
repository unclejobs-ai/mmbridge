import fs from 'node:fs';
import { getLiveStatePath } from '@mmbridge/core';
import type { LiveState } from '@mmbridge/core';
import { useEffect, useState } from 'react';

export function useLiveState(pollMs = 500): LiveState | null {
  const [state, setState] = useState<LiveState | null>(null);

  useEffect(() => {
    const livePath = getLiveStatePath();
    const read = () => {
      try {
        const raw = fs.readFileSync(livePath, 'utf8');
        const parsed = JSON.parse(raw) as LiveState;
        setState(parsed.active ? parsed : null);
      } catch {
        setState(null);
      }
    };
    read();
    const interval = setInterval(read, pollMs);
    return () => clearInterval(interval);
  }, [pollMs]);

  return state;
}
