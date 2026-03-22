# @mmbridge/adapters

## 0.6.3

### Patch Changes

- Reposition mmbridge as a multi-model thinking and review control plane.

  This release updates the public package surface to match the broader command set:

  - refresh README and CLI help wording around thinking, review, workflow continuity, and operations
  - add package descriptions across the published workspace packages
  - enforce Node.js >=22 for the CLI package
  - add CLI help regression coverage for the new control-plane messaging

- Updated dependencies
  - @mmbridge/core@0.6.3

## 0.6.1

### Patch Changes

- 26fd086: Fix parallel review run persistence races in bridge mode and correct Gemini adapter file attachment handling.
- Updated dependencies [26fd086]
  - @mmbridge/core@0.6.1

## 0.2.0

### Minor Changes

- Initial release of mmbridge CLI - multi-model AI code review bridge

### Patch Changes

- Updated dependencies
  - @mmbridge/core@0.2.0
