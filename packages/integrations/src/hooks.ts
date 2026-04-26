export function generateHookConfig(): Record<string, unknown> {
  const preToolGateCommand = [
    'python3 -c',
    '\'import json,re,sys; data=json.load(sys.stdin); command=((data.get("tool_input") or {}).get("command") or ""); sys.exit(0 if re.search(r"\\bgit\\s+(?:\\s+-C\\s+\\S+)?\\s+push\\b", command, re.I) else 1)\'',
    '&& mmbridge gate --format compact --project "$PWD" || true',
  ].join(' ');

  return {
    UserPromptSubmit: [
      {
        matcher: '(?i)(commit|push|pr|merge)',
        hooks: [
          {
            type: 'command',
            command: 'mmbridge gate --format compact --project "$PWD" || true',
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: preToolGateCommand,
          },
        ],
      },
    ],
  };
}
