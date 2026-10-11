import { render } from 'ink';
import React from 'react';
import { AppBoard } from './AppBoard.js';
import type { BoardStore } from './store.js';

export { createBoardStore } from './store.js';

export interface RenderApsBoardOptions {
  store: BoardStore;
  onRefresh: () => void | Promise<void>;
  onQuit: () => void | Promise<void>;
}

/** CLI owns readers, polling, and cleanup; this renderer only consumes snapshots. */
export async function renderApsBoard({ store, onRefresh, onQuit }: RenderApsBoardOptions): Promise<void> {
  let closing: Promise<void> | undefined;
  const quit = () => {
    closing ??= Promise.resolve().then(onQuit);
    return closing;
  };
  const alternateScreen = process.stdout.isTTY;
  if (alternateScreen) process.stdout.write('\x1B[?1049h\x1B[2J\x1B[H');
  try {
    const instance = render(<AppBoard store={store} onRefresh={onRefresh} onQuit={quit} />, {
      exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
  } finally {
    try {
      await quit();
    } finally {
      if (alternateScreen) process.stdout.write('\x1B[?1049l');
    }
  }
}
