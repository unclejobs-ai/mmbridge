export function generateHookConfig(): Record<string, unknown> {
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
            command:
              'bash -c \'echo "$TOOL_INPUT" | grep -q "git push" && mmbridge gate --format compact --project "$PWD" || true\'',
          },
        ],
      },
    ],
  };
}
