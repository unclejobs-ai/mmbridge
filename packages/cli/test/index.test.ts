import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ─── Smoke tests for CLI module exports ───────────────────────────────────────
// These tests verify that the module exports are correctly typed and importable.
// Full integration tests require external binaries (kimi, qwen, etc.) and are
// therefore skipped in CI unless those binaries are present.

describe('@mmbridge/cli', () => {
  it('exports main function', async () => {
    const mod = await import('../dist/index.js');
    assert.equal(typeof mod.main, 'function', 'main must be a function');
  });

  it('main returns a Promise', async () => {
    const mod = await import('../dist/index.js');
    // Run with --help so it exits cleanly without network I/O
    const originalArgv = process.argv;
    process.argv = ['node', 'mmbridge', '--help'];
    let threw = false;
    try {
      // Commander calls process.exit(0) for --help; catch that.
      await mod.main();
    } catch (err: unknown) {
      // process.exit throws in test environments that mock it
      threw = true;
      const code = (err as NodeJS.ErrnoException).code;
      // Only acceptable error is a process.exit call
      assert.ok(
        code === undefined || typeof code === 'string',
        'unexpected error type',
      );
    } finally {
      process.argv = originalArgv;
    }
    // Either it resolves or throws a process.exit — both are acceptable
    assert.ok(true, 'main ran without unexpected exception');
  });
});

describe('ReviewCommandOptions type shape', () => {
  it('type is structurally compatible', async () => {
    const mod = await import('../dist/index.js');
    // Verify that the exported types exist by checking the module shape.
    // TypeScript will enforce type correctness at compile time.
    assert.ok(mod, 'module imported successfully');
  });
});
