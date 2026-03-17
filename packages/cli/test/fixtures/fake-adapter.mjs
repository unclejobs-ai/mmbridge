function makeResult({ tool = 'fixture', text, externalSessionId, followupSupported = true, command, args = [] }) {
  return {
    tool,
    externalSessionId,
    followupSupported,
    command,
    args,
    ok: true,
    code: 0,
    stdout: text,
    stderr: '',
    combined: text,
    text,
  };
}

const adapter = {
  name: 'fixture',
  binary: 'node',
  async review(options) {
    const finding = '**[WARNING]** src/app.ts:1 — Fixture adapter detected a changed constant.';
    const summary = `Fixture review complete for mode "${options.mode ?? 'review'}".`;
    return makeResult({
      text: `${finding}\n${summary}`,
      externalSessionId: 'fixture-session-001',
      followupSupported: true,
      command: 'fixture-review',
      args: [],
    });
  },
  async followup(options) {
    const finding = `**[INFO]** src/app.ts:1 — Follow-up accepted for session ${options.sessionId}.`;
    return makeResult({
      text: `${finding}\nPrompt: ${options.prompt}`,
      externalSessionId: options.sessionId,
      followupSupported: true,
      command: 'fixture-followup',
      args: [],
    });
  },
};

export { adapter };
export default adapter;
