function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeResult({ text, sessionId }) {
  return {
    tool: 'streamfixture',
    externalSessionId: sessionId ?? 'stream-session-001',
    followupSupported: true,
    command: 'streamfixture-review',
    args: [],
    ok: true,
    code: 0,
    stdout: text,
    stderr: '',
    combined: text,
    text,
  };
}

const adapter = {
  name: 'streamfixture',
  binary: 'node',
  async review(options) {
    options.onStdout?.('{"type":"item.started","item":{"type":"collab_tool_call","tool":"spawn_agent"}}\n');
    await delay(350);
    options.onStdout?.('first streamed chunk\n');
    await delay(350);
    options.onStdout?.('{"type":"item.completed","item":{"type":"command_execution"}}\nsecond streamed chunk\n');
    await delay(500);
    return makeResult({
      text: '**[INFO]** src/app.ts:1 — streaming harness ok.',
    });
  },
  async followup() {
    return makeResult({
      text: '**[INFO]** src/app.ts:1 — follow-up from stream.',
      sessionId: 'stream-session-001',
    });
  },
};

export { adapter };
export default adapter;
