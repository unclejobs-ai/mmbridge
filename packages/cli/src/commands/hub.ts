import type { DispatchResult, ImplementResult } from '@mmbridge/dispatch';
import type { GateView, HubSink } from '@mmbridge/tui';

export interface HubCommandOptions {
  task: string;
  /** Roles for parallel dispatch lanes (default: one worker). */
  roles: string[];
  model?: string;
  project?: string;
  /** Run the gated implement flow instead: worker lane, reviewer lane, validation, gate. */
  implement?: boolean;
  validate?: string;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function diffStat(diff: string): string {
  const files = diff.split('\n').filter((line) => line.startsWith('diff --git ')).length;
  const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const removed = diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return `diff: ${files} file${files === 1 ? '' : 's'}, +${added} −${removed}`;
}

function gateView(result: ImplementResult): GateView {
  const details = [
    result.diff ? diffStat(result.diff) : null,
    result.review
      ? `review: ${result.review.model} ${result.review.verdict}, ${result.review.findings.length} finding(s)`
      : null,
    result.validate ? `validate: ${result.validate.command} → exit ${result.validate.exitCode}` : null,
    `branch: ${result.branch} (changes staged in ${result.worktree})`,
    `cleanup: ${result.cleanup}`,
  ];
  return { verdict: result.gate, reasons: result.reasons, details: details.filter((d) => d !== null) };
}

async function runImplementHub(options: HubCommandOptions, cwd: string): Promise<void> {
  const { implement } = await import('@mmbridge/dispatch');
  const { renderHub } = await import('@mmbridge/tui');
  const lane = { worker: 0, reviewer: 1 } as const;
  const result = await renderHub({
    title: options.task,
    roles: ['worker', 'reviewer'],
    run: async (sink: HubSink) => {
      const outcome = await implement({
        task: options.task,
        projectDir: cwd,
        ...(options.validate ? { validate: options.validate } : {}),
        onEvent: (e) => {
          if (e.stage === 'validate') sink.activity(`validate: ${e.command}`);
          else if ('ended' in e) sink.finish(lane[e.stage], e.ended);
          else sink.event(lane[e.stage], e.event);
        },
        onControl: (stage, control) => sink.control(lane[stage], control),
      });
      sink.gate(gateView(outcome));
      return outcome;
    },
  });
  printJson(result);
  if (result.gate === 'block') process.exitCode = 1;
}

/**
 * An answer to the hub's task prompt. A bare role name ("worker") is the
 * question misread as "which role?" — sending it as the task left the model
 * with nothing to do, and it went looking through handoffs for one.
 */
export function resolveHubTaskAnswer(answer: string): { task: string } | { retry: string } {
  const task = answer.trim();
  if (!task) return { retry: 'Type what the model should do.' };
  const role = task.toLowerCase();
  if ((['worker', 'scout', 'reviewer', 'designer'] as const).some((name) => name === role)) {
    return { retry: `"${task}" is a role, not a task. Pick roles with -r (mmbridge hub -r ${role}); type the task.` };
  }
  return { task };
}

/** `mmbridge hub` with no task asks for one first, instead of a missing-argument error. */
export async function promptHubTask(roles: readonly string[] = []): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('mmbridge hub needs a task: mmbridge hub "<task>"');
  const who = roles.length > 0 ? roles.join(' + ') : 'worker';
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = resolveHubTaskAnswer(await rl.question(`mmbridge hub · what should the ${who} do? › `));
      if ('task' in answer) return answer.task;
      process.stdout.write(`  ${answer.retry}\n`);
    }
  } finally {
    rl.close();
  }
}

export async function runHubCommand(options: HubCommandOptions): Promise<void> {
  const cwd = options.project ?? process.cwd();
  if (options.implement) {
    if (options.roles.length > 0 || options.model) {
      throw new Error('--implement runs its own worker and a different-provider reviewer; drop -r/--model');
    }
    await runImplementHub(options, cwd);
    return;
  }
  if (options.validate) throw new Error('--validate only applies with --implement');

  const { ROLES, dispatch, isRole } = await import('@mmbridge/dispatch');
  const { renderHub } = await import('@mmbridge/tui');
  const requested = options.roles.length > 0 ? options.roles : ['worker'];
  const invalid = requested.find((role) => !isRole(role));
  if (invalid) throw new Error(`Invalid role "${invalid}": expected one of ${ROLES.join(', ')}`);
  const roles = requested.filter(isRole);

  const results = await renderHub({
    title: options.task,
    roles,
    run: (sink: HubSink) =>
      Promise.all(
        roles.map((role, i) =>
          dispatch({
            role,
            task: options.task,
            cwd,
            onEvent: (event) => sink.event(i, event),
            onControl: (control) => sink.control(i, control),
            ...(options.model ? { model: options.model } : {}),
          }).then(
            (result): DispatchResult | Error => {
              sink.finish(i, result);
              return result;
            },
            (err: unknown) => {
              const error = toError(err);
              sink.finish(i, error);
              return error;
            },
          ),
        ),
      ),
  });
  printJson(results.map((result) => (result instanceof Error ? { error: result.message } : result)));
  if (results.some((result) => result instanceof Error || result.stopReason === 'error')) process.exitCode = 1;
}
