import type { LiveState } from '@mmbridge/core';
import type { Finding, InterpretResult, ResultIndex } from '@mmbridge/core';
import type { SessionToolResult } from '@mmbridge/session-store';
import { Box, Text } from 'ink';
import type React from 'react';
import { CHARS, colors, severityColor, severityIcon, toolColor } from '../theme.js';
import { countBySeverity } from '../utils/format.js';
import { Panel } from './Panel.js';

type FlowStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

interface ToolFlow {
  tool: string;
  status: FlowStatus;
  findingCount?: number;
  detail?: string;
}

interface FlowNode {
  label: string;
  status: FlowStatus;
  detail?: string;
  accentColor?: string;
}

interface ReviewFlowMapProps {
  title: string;
  context: FlowNode;
  tools: ToolFlow[];
  bridge?: FlowNode | null;
  interpretation?: FlowNode | null;
  findings: FlowNode;
  footer?: string | null;
}

const FLOW_PHASES = ['context', 'review', 'bridge', 'interpret', 'enrich'] as const;

function statusIcon(status: FlowStatus): string {
  switch (status) {
    case 'done':
      return CHARS.installed;
    case 'running':
      return CHARS.radioOn;
    case 'error':
      return CHARS.missing;
    case 'skipped':
      return CHARS.collapsed;
    default:
      return CHARS.radioOff;
  }
}

function statusColor(status: FlowStatus): string {
  switch (status) {
    case 'done':
      return colors.green;
    case 'running':
      return colors.accent;
    case 'error':
      return colors.red;
    case 'skipped':
      return colors.yellow;
    default:
      return colors.textDim;
  }
}

function formatSeveritySummary(findings: Finding[]): string {
  const counts = countBySeverity(findings);
  const parts: string[] = [];
  if (counts.critical > 0) parts.push(`${counts.critical} CRI`);
  if (counts.warning > 0) parts.push(`${counts.warning} WRN`);
  if (counts.info > 0) parts.push(`${counts.info} INF`);
  if (counts.refactor > 0) parts.push(`${counts.refactor} REF`);
  return parts.join(' · ') || 'No findings';
}

function shorten(value: string, max = 42): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function derivePhaseStatus(currentPhase: string, targetPhase: (typeof FLOW_PHASES)[number]): FlowStatus {
  const currentIndex = FLOW_PHASES.indexOf(currentPhase as (typeof FLOW_PHASES)[number]);
  const targetIndex = FLOW_PHASES.indexOf(targetPhase);
  if (currentIndex === -1) return 'done';
  if (targetIndex < currentIndex) return 'done';
  if (targetIndex === currentIndex) return 'running';
  return 'pending';
}

function deriveLiveTools(liveState: LiveState): ToolFlow[] {
  const toolEvents = new Map<string, ToolFlow>();
  for (const event of liveState.events) {
    const match = event.message.match(/^review:\s+([a-z0-9_-]+):\s+(start|done|error)$/i);
    if (!match) continue;
    const [, toolName, rawStatus] = match;
    const status = rawStatus === 'start' ? 'running' : ((rawStatus === 'done' ? 'done' : 'error') as FlowStatus);
    toolEvents.set(toolName, {
      tool: toolName,
      status,
      detail: rawStatus === 'done' ? 'completed' : rawStatus,
    });
  }

  if (toolEvents.size > 0) {
    return [...toolEvents.values()];
  }

  if (liveState.tool !== 'all') {
    return [
      {
        tool: liveState.tool,
        status: derivePhaseStatus(liveState.phase, 'review'),
        detail: liveState.phase === 'review' ? 'streaming' : liveState.phase === 'context' ? 'queued' : 'completed',
      },
    ];
  }

  return [
    {
      tool: 'parallel',
      status: derivePhaseStatus(liveState.phase, 'review'),
      detail: 'starting tool lanes',
    },
  ];
}

export function buildLiveReviewFlow(liveState: LiveState): ReviewFlowMapProps {
  const tools = deriveLiveTools(liveState);
  const bridgeEnabled = liveState.tool === 'all' || liveState.phase === 'bridge' || liveState.phase === 'interpret';
  const interpretationEnabled = liveState.phase === 'interpret';

  const findingsDetail =
    liveState.phase === 'enrich'
      ? `${liveState.events.length} events · parsing results`
      : liveState.phase === 'interpret'
        ? 'waiting for interpretation'
        : 'pending review output';

  return {
    title: 'LIVE REVIEW MAP',
    context: {
      label: 'Context',
      status: derivePhaseStatus(liveState.phase, 'context'),
      detail: liveState.phase === 'context' ? 'building workspace' : 'workspace ready',
    },
    tools,
    bridge: bridgeEnabled
      ? {
          label: 'Bridge',
          status: derivePhaseStatus(liveState.phase, 'bridge'),
          detail: liveState.phase === 'bridge' ? 'consensus in progress' : 'multi-tool merge',
          accentColor: colors.mauve,
        }
      : null,
    interpretation: interpretationEnabled
      ? {
          label: 'Interpret',
          status: derivePhaseStatus(liveState.phase, 'interpret'),
          detail: 'codex validating consensus',
          accentColor: colors.peach,
        }
      : null,
    findings: {
      label: 'Findings',
      status: derivePhaseStatus(liveState.phase, 'enrich'),
      detail: findingsDetail,
      accentColor: colors.sky,
    },
    footer: `${liveState.tool} · ${liveState.mode}`,
  };
}

export function buildSessionReviewFlow(input: {
  tool: string;
  mode: string;
  status?: string;
  findings: Finding[];
  toolResults?: SessionToolResult[];
  resultIndex?: ResultIndex | null;
  interpretation?: InterpretResult | null;
  changedFiles?: number | null;
  ancestryChain?: string[];
}): ReviewFlowMapProps {
  const toolResults = input.toolResults ?? [];
  const status: FlowStatus = input.status === 'error' ? 'error' : 'done';
  const tools: ToolFlow[] =
    toolResults.length > 0
      ? toolResults.map((result) => ({
          tool: result.tool,
          status: result.error ? 'error' : result.skipped ? 'skipped' : 'done',
          findingCount: result.findingCount,
          detail: result.error ? 'failed' : result.skipped ? 'skipped' : `${result.findingCount} finding(s)`,
        }))
      : [
          {
            tool: input.tool,
            status,
            findingCount: input.findings.length,
            detail: `${input.findings.length} finding(s)`,
          },
        ];

  const interpretation = input.interpretation;
  const footer =
    input.ancestryChain && input.ancestryChain.length > 1
      ? `chain ${input.ancestryChain.map((id) => `#${id.slice(0, 6)}`).join(' -> ')}`
      : `${input.tool} · ${input.mode}`;

  return {
    title: 'SESSION MAP',
    context: {
      label: 'Context',
      status,
      detail:
        input.changedFiles && input.changedFiles > 0
          ? `${input.changedFiles} changed file(s)`
          : 'saved session context',
    },
    tools,
    bridge:
      input.tool === 'bridge' || input.resultIndex?.hasBridge
        ? {
            label: 'Bridge',
            status,
            detail: shorten(input.resultIndex?.bridgeSummary ?? `${input.findings.length} consensus finding(s)`),
            accentColor: colors.mauve,
          }
        : null,
    interpretation:
      interpretation != null
        ? {
            label: 'Interpret',
            status,
            detail: `${interpretation.validated.length} valid · ${interpretation.falsePositives.length} false+`,
            accentColor: colors.peach,
          }
        : null,
    findings: {
      label: 'Findings',
      status,
      detail: formatSeveritySummary(input.findings),
      accentColor: colors.sky,
    },
    footer,
  };
}

function FlowStep({ node }: { node: FlowNode }): React.ReactElement {
  const iconCol = node.accentColor ?? statusColor(node.status);
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={iconCol}>{statusIcon(node.status)}</Text>
      <Text color={colors.text} bold>
        {node.label.padEnd(10)}
      </Text>
      <Text color={node.accentColor ?? statusColor(node.status)}>{node.detail ?? ''}</Text>
    </Box>
  );
}

function ToolLane({ tools }: { tools: ToolFlow[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text color={colors.accent}>
          {statusIcon(tools.some((tool) => tool.status === 'running') ? 'running' : 'done')}
        </Text>
        <Text color={colors.text} bold>
          {'Tools'.padEnd(10)}
        </Text>
        <Text color={colors.textDim}>{tools.length > 1 ? `${tools.length} lanes` : 'single lane'}</Text>
      </Box>
      {tools.map((tool) => (
        <Box key={`${tool.tool}-${tool.status}`} flexDirection="row" gap={1} marginLeft={2}>
          <Text color={colors.textDim}>├</Text>
          <Text color={toolColor(tool.tool)}>{statusIcon(tool.status)}</Text>
          <Text color={toolColor(tool.tool)} bold>
            {tool.tool.padEnd(8)}
          </Text>
          <Text color={colors.subtext0}>
            {tool.findingCount != null ? `${tool.findingCount} · ` : ''}
            {tool.detail ?? ''}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function ReviewFlowMap({
  title,
  context,
  tools,
  bridge,
  interpretation,
  findings,
  footer,
}: ReviewFlowMapProps): React.ReactElement {
  const stages: Array<FlowNode | { kind: 'tools'; tools: ToolFlow[] }> = [
    context,
    { kind: 'tools', tools },
    ...(bridge ? [bridge] : []),
    ...(interpretation ? [interpretation] : []),
    findings,
  ];

  return (
    <Panel title={title} flexGrow={1} borderColor={colors.surface1}>
      <Box flexDirection="column" marginTop={1}>
        {stages.map((stage, index) => {
          const key = 'kind' in stage ? `tools-${index}` : `${stage.label}-${index}`;
          return (
            <Box key={key} flexDirection="column">
              {'kind' in stage ? <ToolLane tools={stage.tools} /> : <FlowStep node={stage} />}
              {index < stages.length - 1 && (
                <Box marginLeft={1}>
                  <Text color={colors.textDim}>│</Text>
                  <Text color={colors.textDim}>↓</Text>
                </Box>
              )}
            </Box>
          );
        })}
        {footer && (
          <Box marginTop={1}>
            <Text color={colors.overlay1}>{footer}</Text>
          </Box>
        )}
      </Box>
    </Panel>
  );
}

export function ConsensusSnapshot({
  findings,
  interpretation,
  fallbackTool,
}: {
  findings: Finding[];
  interpretation?: InterpretResult | null;
  fallbackTool: string;
}): React.ReactElement {
  const falsePositiveKeys = new Set(
    (interpretation?.falsePositives ?? []).map(
      (entry) => `${entry.finding.severity}:${entry.finding.file}:${entry.finding.line ?? ''}:${entry.finding.message}`,
    ),
  );

  const visible = findings.slice(0, 4);

  return (
    <Panel title="CONSENSUS" flexGrow={1} borderColor={colors.surface1}>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text color={colors.textDim}>No findings captured</Text>
        ) : (
          visible.map((finding, index) => {
            const key = `${finding.severity}:${finding.file}:${finding.line ?? ''}:${finding.message}`;
            const sources = finding.sources && finding.sources.length > 0 ? finding.sources : [fallbackTool];
            const status = falsePositiveKeys.has(key) ? 'false+' : interpretation ? 'keep' : 'final';
            const statusCol = status === 'false+' ? colors.yellow : colors.green;
            const location = finding.line != null ? `${finding.file}:${finding.line}` : finding.file || '(no file)';
            return (
              <Box key={key} flexDirection="column" marginBottom={index < visible.length - 1 ? 1 : 0}>
                <Box flexDirection="row" gap={1}>
                  <Text color={severityColor(finding.severity)}>{severityIcon(finding.severity)}</Text>
                  <Text color={colors.text} bold>
                    {shorten(location, 28)}
                  </Text>
                  <Text color={statusCol}>[{status}]</Text>
                </Box>
                <Box flexDirection="row" gap={1} marginLeft={2} flexWrap="wrap">
                  {sources.map((source) => (
                    <Text key={`${key}-${source}`} color={toolColor(source)}>
                      {source}
                    </Text>
                  ))}
                </Box>
                <Text color={colors.subtext0} wrap="truncate-end">
                  {shorten(finding.message, 78)}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Panel>
  );
}
