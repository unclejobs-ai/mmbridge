import { Box, Text } from 'ink';
import React from 'react';
import { colors } from '../theme.js';
import { formatAge, migrationHint, wrapLines } from './format.js';
import type { CardRow } from './store.js';

export function cardDetailLines(card: CardRow, runsAvailable: boolean, readAt: string): string[] {
  const lines = [
    `${card.cardId} · ${card.title}`,
    `${card.project} · ${card.kind} · ${card.kanbanKo} (${card.state}) · age ${formatAge(card.since, readAt)}`,
    `Lane ${card.lane} · assignee ${card.assignee ?? 'none'} (${card.assigneeStatus ?? 'none'}) · owner ${card.layerOwner}`,
    `Model ${card.model ?? 'none'} · pane ${card.herdrPane ?? 'none'}`,
    `Attempt ${card.attempt} · rework ${card.reworkCount}/3 · acceptance criteria ${card.acceptanceCount}`,
    `SHA ${card.sha ?? 'none'} · report ${card.reportStatus ?? 'none'} · review ${card.latestReview ?? 'none'}`,
    `Vision ${card.latestVision ?? 'none'} (required ${Boolean(card.needsVision)}) · owner OK ${Boolean(card.ownerOk)} (required ${Boolean(card.needsOwner)}) · merge OK ${Boolean(card.mergeOk)}`,
    '',
    'Next blockers',
    ...(card.nextBlockers.length ? card.nextBlockers.map((blocker) => `  ${blocker}`) : ['  none']),
    '',
    'Transitions',
    ...(card.timeline.length
      ? card.timeline.map(
          (row) => `  ${row.at} ${row.fromState ?? 'new'} → ${row.toState} · ${row.byAgent} · ${row.note}`,
        )
      : ['  no transitions']),
    '',
    'Reports (latest first)',
  ];
  if (!card.reports.length) lines.push('  no reports');
  for (const report of card.reports) {
    lines.push(
      `  #${report.id} ${report.at} · attempt ${report.attempt} · ${report.status} · ${report.byAgent}`,
      `  SHA ${report.sha} · branch ${report.branch} · PR ${report.prUrl ?? 'none'}`,
      `  Risks: ${report.risks || 'none'}`,
      `  Files: ${report.filesJson}`,
      `  Evidence: ${report.evidenceJson}`,
      report.bodyMd,
    );
  }
  lines.push('', 'Reviews');
  if (!card.reviews.length) lines.push('  no reviews');
  for (const review of card.reviews) {
    lines.push(
      `  ${review.at} ${review.verdict} · ${review.reviewer} (${review.layer}) · attempt ${review.attempt} · SHA ${review.sha}`,
      `  Items: ${review.itemsJson}`,
    );
  }
  lines.push('', 'Vision audits');
  if (!card.visionAudits.length) lines.push('  no vision audits');
  for (const audit of card.visionAudits) {
    lines.push(
      `  ${audit.at} ${audit.verdict} · ${audit.auditor} · attempt ${audit.attempt} · SHA ${audit.sha}`,
      `  Screenshots: ${audit.screenshotsJson}`,
      `  Items: ${audit.itemsJson} · ${audit.notes}`,
    );
  }
  lines.push('', 'Links');
  if (!card.links.length) lines.push('  no links');
  for (const link of card.links) lines.push(`  ${link.at} ${link.kind} · ${link.ref} · ${link.detailJson}`);
  lines.push('', 'Runs');
  if (!runsAvailable) lines.push(`  ${migrationHint}`);
  else if (!card.runs.length) lines.push('  no dispatched runs');
  if (runsAvailable)
    for (const run of card.runs) {
      lines.push(
        `  ${run.runId} · attempt ${run.attempt} · ${run.harness}${run.kind ? `/${run.kind}` : ''} · ${run.model} · ${run.status}`,
        `  Since ${run.since} · agent ${run.agentId} · worktree ${run.worktree} · branch ${run.branch}`,
        `  Workspace ${run.workspaceId ?? 'none'} · tab ${run.tabId ?? 'none'} · pane ${run.paneId ?? 'none'} · terminal ${run.terminalId ?? 'none'} · pid ${run.pid ?? 'none'}`,
        `  Session ${run.sessionRef ?? 'none'} · packet ${run.packetDir} · report.json ${run.reportPresent ? 'present' : 'missing'}`,
      );
      for (const event of run.events)
        lines.push(`    ${event.at} ${event.status} · ${event.byAgent} · ${event.detailJson}`);
    }
  return lines;
}

export function CardDetail({
  card,
  runsAvailable,
  readAt,
  width,
  capacity,
  offset,
}: {
  card: CardRow;
  runsAvailable: boolean;
  readAt: string;
  width: number;
  capacity: number;
  offset: number;
}) {
  const lines = wrapLines(cardDetailLines(card, runsAvailable, readAt), width);
  const start = Math.max(0, Math.min(offset, lines.length - capacity));
  return (
    <Box flexDirection="column">
      <Text bold color={colors.accent}>
        Card detail · Esc back · ↑↓ scroll · line {start + 1}/{lines.length}
      </Text>
      {lines.slice(start, start + capacity).map((line, index) => (
        <Text key={`${start + index}/${line}`} color={line === 'Next blockers' ? colors.yellow : colors.text}>
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
}
