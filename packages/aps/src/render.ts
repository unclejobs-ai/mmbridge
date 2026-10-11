import type { DatabaseSync } from 'node:sqlite';
import { getCard } from './ledger.js';

interface Acceptance {
  id: string;
  text: string;
  command?: string;
  expect?: string;
}
export function renderCardPrompt(db: DatabaseSync, id: string): string {
  const card = getCard(db, id);
  const acceptance = JSON.parse(String(card.acceptance_json)) as Acceptance[];
  const lines = [
    `# ${id}: ${card.title}`,
    `Project: ${card.project} | Kind: ${card.kind} | Size: ${card.size}`,
    `Manager: ${card.layer_owner} | Assignee: ${card.assignee ?? '(unassigned)'}`,
    `needs_owner=${card.needs_owner} needs_vision=${card.needs_vision}`,
  ];
  if (Number(card.attempt) > 1 || card.state === 'revise') {
    lines.push(`\n## REWORK ${card.rework_count} of 3`);
    const revise = db
      .prepare("SELECT id FROM transitions WHERE card_id=? AND to_state='revise' ORDER BY id DESC LIMIT 1")
      .get(id);
    if (revise) {
      const finding = db
        .prepare(
          `SELECT items_json FROM (SELECT items_json,at,id FROM reviews WHERE card_id=? AND verdict='revise' UNION ALL SELECT items_json,at,id FROM vision_audits WHERE card_id=? AND verdict='fail') ORDER BY at DESC,id DESC LIMIT 1`,
        )
        .get(id, id);
      for (const item of JSON.parse(String(finding?.items_json ?? '[]')) as {
        severity: string;
        text: string;
        ref?: string;
      }[])
        lines.push(`- ${item.severity}: ${item.text}${item.ref ? ` (${item.ref})` : ''}`);
    }
  }
  lines.push(
    `\n## Goal\n${card.title}`,
    `\n## Scope\n${card.scope}`,
    `\n## Details\n${card.body_md}`,
    '\n## Acceptance',
  );
  for (const ac of acceptance)
    lines.push(
      `- ${ac.id}: ${ac.text}${ac.command ? `\n  Command: ${ac.command}` : ''}${ac.expect ? `\n  Expect: ${ac.expect}` : ''}`,
    );
  lines.push(
    `\n## Forbidden\n${card.forbidden}`,
    '\n## When done',
    '1. Commit the changes.',
    `2. Save this evidence template as ${id}-evidence.json, replacing output and ok with actual results:`,
    '```json',
    JSON.stringify(
      acceptance.map((ac) => ({ ac: ac.id, command: ac.command ?? '', output: '', ok: false })),
      null,
      2,
    ),
    '```',
    `3. Run: mmbridge aps report ${id} --by ${card.assignee ?? '<agent>'} --sha <commit-sha> --branch <branch> --files '@files.json' --evidence ${id}-evidence.json --status DONE`,
    `4. Write ~/ss-work/aps/reports/${id}.md in COMPLETION-REPORT form (CARD, RESULT, BRANCH/SHA, FILES, EVIDENCE, RISKS, STATUS, CLOSED).`,
    `5. Have a manager run: mmbridge aps close-session ${card.assignee ?? '<agent>'} --by ${card.layer_owner} --note 'work complete; pane ended'`,
  );
  return `${lines.join('\n')}\n`;
}
export function renderTodo(db: DatabaseSync, project?: string): string {
  const rows = db
    .prepare('SELECT * FROM v_kanban WHERE (? IS NULL OR project=?) ORDER BY state_ord,card_id')
    .all(project ?? null, project ?? null);
  const lines = ['# APS Kanban', ''];
  for (const state of db.prepare('SELECT * FROM states ORDER BY ord').all()) {
    lines.push(
      `## ${state.kanban_ko}`,
      '',
      '| id | title | assignee | manager | attempt/rework | since |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const card of rows.filter((row) => row.state === state.name)) {
      const cells = [
        card.card_id,
        card.title,
        card.assignee ?? '',
        card.layer_owner,
        `${card.attempt}/${card.rework_count}`,
        card.since,
      ];
      lines.push(
        `| ${cells
          .map((cell) =>
            String(cell ?? '')
              .replace(/\|/g, '\\|')
              .replace(/[\r\n]/g, ' '),
          )
          .join(' | ')} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
