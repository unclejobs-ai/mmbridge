# Contributing to mmBridge

Thank you for your interest in contributing to mmBridge!

## Development Setup

```bash
git clone https://github.com/EungjePark/mmbridge.git
cd mmbridge
pnpm install
pnpm run typecheck
pnpm run test
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run `pnpm run lint && pnpm run typecheck && pnpm run test`
5. Commit with conventional commits (`feat:`, `fix:`, `docs:`, etc.)
6. Open a Pull Request

## Adding a Custom Adapter

See `docs/adapter-authoring.md` for the complete guide.

## Code Style

We use Biome for linting and formatting. Run `pnpm run lint:fix` before committing.
