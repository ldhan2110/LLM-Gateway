```markdown
# LLM-Gateway Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the LLM-Gateway repository, a TypeScript project built with the Next.js framework. It covers file and code style conventions, how to structure imports and exports, and how to approach testing. This guide will help you contribute code that fits seamlessly into the project.

## Coding Conventions

### File Naming
- Use **camelCase** for all file names.
  - Example: `llmGateway.ts`, `apiHandler.ts`

### Import Style
- Use **relative imports** for internal modules.
  - Example:
    ```typescript
    import { fetchData } from './utils/fetchData';
    ```

### Export Style
- Use **named exports** rather than default exports.
  - Example:
    ```typescript
    // Good
    export function processRequest() { ... }

    // Bad
    export default function processRequest() { ... }
    ```

### Commit Patterns
- Commits may use freeform messages, sometimes prefixed with `deps` for dependency updates.
- Keep commit messages concise (average ~66 characters).

## Workflows

*No automated workflows were detected in the repository.*

## Testing Patterns

- **Test Framework:** Unknown (not detected)
- **Test File Pattern:** All test files follow the `*.test.*` naming convention.
  - Example: `apiHandler.test.ts`
- Place tests alongside the code or in a dedicated test directory, following the naming pattern.

### Example Test File
```typescript
// apiHandler.test.ts
import { apiHandler } from './apiHandler';

describe('apiHandler', () => {
  it('should handle requests correctly', () => {
    // test implementation
  });
});
```

## Commands
| Command | Purpose |
|---------|---------|
| /test   | Run all test files matching `*.test.*` |
| /lint   | Lint the codebase according to project standards |
| /deps   | Update project dependencies |
```