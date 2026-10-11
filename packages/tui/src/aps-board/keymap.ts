export type BoardView = 'lanes' | 'review' | 'cost' | 'hygiene';

export interface BoardNavigation {
  view: BoardView;
  selectedIndex: number;
  project: string | null;
  detailCardId: string | null;
  detailOffset: number;
  help: boolean;
}

export type BoardAction =
  | { type: 'view'; view: BoardView }
  | { type: 'select'; index: number }
  | { type: 'move'; delta: number }
  | { type: 'detail' }
  | { type: 'back' }
  | { type: 'project'; project: string | null }
  | { type: 'cycle-project' }
  | { type: 'help' }
  | { type: 'refresh' }
  | { type: 'quit' };

export interface NavigationContext {
  rowCount: number;
  selectedCardId: string | null;
  projects: string[];
}

export const initialNavigation: BoardNavigation = {
  view: 'lanes',
  selectedIndex: 0,
  project: null,
  detailCardId: null,
  detailOffset: 0,
  help: false,
};

export function reduceBoardKey(
  state: BoardNavigation,
  action: BoardAction,
  context: NavigationContext,
): BoardNavigation {
  switch (action.type) {
    case 'view':
      return { ...state, view: action.view, selectedIndex: 0, detailCardId: null, detailOffset: 0, help: false };
    case 'select':
      return { ...state, selectedIndex: Math.max(0, Math.min(action.index, context.rowCount - 1)) };
    case 'move':
      if (state.help) return state;
      if (state.detailCardId) return { ...state, detailOffset: Math.max(0, state.detailOffset + action.delta) };
      return {
        ...state,
        selectedIndex: Math.max(0, Math.min(state.selectedIndex + action.delta, context.rowCount - 1)),
      };
    case 'detail':
      if (state.help || !context.selectedCardId) return state;
      return { ...state, detailCardId: context.selectedCardId, detailOffset: 0 };
    case 'back':
      return { ...state, detailCardId: null, detailOffset: 0, help: false };
    case 'project':
      return { ...state, project: action.project, selectedIndex: 0, detailCardId: null, detailOffset: 0 };
    case 'cycle-project': {
      const projects: (string | null)[] = [null, ...context.projects];
      const project = projects[(projects.indexOf(state.project) + 1) % projects.length] ?? null;
      return { ...state, project, selectedIndex: 0, detailCardId: null, detailOffset: 0 };
    }
    case 'help':
      return { ...state, help: !state.help };
    case 'refresh':
    case 'quit':
      return state;
  }
}

export function boardKeyAction(
  input: string,
  key: { upArrow?: boolean; downArrow?: boolean; return?: boolean; escape?: boolean; ctrl?: boolean },
): BoardAction | null {
  if (input === 'q' || (key.ctrl && input === 'c')) return { type: 'quit' };
  if (input === 'r') return { type: 'refresh' };
  if (key.escape) return { type: 'back' };
  if (key.return) return { type: 'detail' };
  if (key.upArrow) return { type: 'move', delta: -1 };
  if (key.downArrow) return { type: 'move', delta: 1 };
  const views: Record<string, BoardView> = { '1': 'lanes', '2': 'review', '3': 'cost', '4': 'hygiene' };
  if (views[input]) return { type: 'view', view: views[input] };
  if (input === 'p') return { type: 'cycle-project' };
  if (input === '?') return { type: 'help' };
  return null;
}
