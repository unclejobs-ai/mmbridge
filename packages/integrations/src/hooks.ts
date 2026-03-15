export function generateHookConfig(): Record<string, unknown> {
  return {
    UserPromptSubmit: [
      {
        matcher: '(?i)(commit|push|pr|merge)',
        hooks: [
          {
            type: 'command',
            command: 'mmbridge review --tool codex --mode review --json --quiet 2>/dev/null | head -5 || true',
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
            command:
              'bash -c \'echo "$TOOL_INPUT" | grep -q "git push" && mmbridge review --tool codex --mode security --json --quiet 2>/dev/null | head -3 || true\'',
          },
        ],
      },
    ],
  };
}
