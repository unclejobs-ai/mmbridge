// Re-export everything from the ink-based entry point.
// This file exists because TypeScript module resolution (Node16) prefers .ts over .tsx.
// The actual implementation lives in index.tsx.
export * from './index-impl.js';
export { createBoardStore, renderApsBoard } from './aps-board/render.js';
