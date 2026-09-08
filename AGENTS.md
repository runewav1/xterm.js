# xterm.js Copilot Instructions

## Architecture Overview

**Core Structure**: xterm.js is a multi-target terminal emulator with three main distributions:
- `src/browser/`: Full-featured browser terminal with DOM rendering
- `src/headless/`: Server-side terminal for Node.js (no DOM)
- `src/common/`: Shared core logic (parsing, buffer management, terminal state)

**Key Classes**:
- `Terminal` (browser/headless): Public API wrapper
- `CoreTerminal` (common): Core terminal logic and state
- `CoreBrowserTerminal` (browser): Browser-specific terminal implementation

## Development Workflow

**Build System**:
```bash
pnpm run build && pnpm run esbuild # Build all TypeScript and bundle
```

**Testing**:
- Unit tests: `pnpm run test-unit` (Mocha)
- Unit tests filtering to file: `pnpm run test-unit **/fileName.ts
- Per-addon unit tests: `pnpm run test-unit addons/addon-image/out-esbuild/*.test.js`
- Integration tests: `pnpm run test-integration` (Playwright across Chrome/Firefox/WebKit)
- Integration tests by file: `pnpm run test-integration test/playwright/InputHandler.test.ts`. Never use grep to filter tests, it doesn't work
- Integration tests by addon: `pnpm run test-integration --suite=addon-search`. Suites always follow the format `addon-<something>`
- Lint: `pnpm run lint` (oxlint with type-aware rules, then ESLint for `naming-convention` only), `pnpm run lint-api` for `typings/`, `pnpm run lint-fix` for oxlint auto-fix
- Lint changes: `pnpm run lint-changes` to lint only changed files, `pnpm run lint-changes-fix` to fix them

## Addon Development Pattern

All addons follow this structure:
```typescript
export class MyAddon implements ITerminalAddon {
  activate(terminal: Terminal): void {
    // Called when loaded via terminal.loadAddon()
    // Register handlers, access terminal APIs
  }
  dispose(): void {
    // Cleanup when addon is disposed
  }
}
```

**Key Examples**:
- `addons/addon-fit/`: Terminal sizing
- `addons/addon-webgl/`: GPU-accelerated rendering
- `addons/addon-search/`: Text search functionality

## Project-Specific Conventions

**TypeScript Project Structure**: Uses TypeScript project references (`tsconfig.all.json`) for incremental builds across browser/headless/addons.

**API Design**: 
- Browser and headless terminals share the same public API
- Proposed APIs require `allowProposedApi: true` option
- Constructor-only options (cols, rows) cannot be changed after instantiation

**Disposable Management**:
- When a disposable object can be replaced over time, prefer a registered `MutableDisposable` over manual dispose/reassign logic.
- Register it on the owning class (for example, `this._register(new MutableDisposable())`) and assign through `.value`; this automatically disposes the previous value and avoids accidentally leaking resources.

**TypeScript Constants**:
- Prefer `const enum` over top-level `const` declarations for primitive constants when appropriate, since values are inlined and avoid runtime property lookups.

**Testing Utilities**: Use `TestUtils.ts` helpers:
- `openTerminal(ctx, options)` for setup
- `pollFor(page, fn, expectedValue)` for async assertions
- `writeSync(page, data)` for terminal input

## Common Patterns

**Parser Integration**: Register custom escape sequence handlers:
```typescript
terminal.parser.registerCsiHandler('m', params => {
  // Handle SGR sequences
  return true; // Handled
});
```

**Buffer Access**: Read terminal content via buffer API:
```typescript
const line = terminal.buffer.active.getLine(0);
const cell = line?.getCell(0);
```

**Events**: All terminals emit standard events (onData, onResize, onRender) plus platform-specific ones.

## Critical Implementation Details

- Terminal rendering uses either DOM or WebGL renderers
- Buffer lines are immutable; create new instances for modifications
- Character width handling supports Unicode 11+ and grapheme clustering
- Mouse events translate web events to terminal protocols (X10, VT200, etc.)
- Color theming supports both palette and true color modes

## Writing unit tests

- Unit tests live alongside the source code file of the thing it's testing with a .test.ts suffix.

## Cursor Cloud specific instructions

**Demo server**: Start with `pnpm start` (port 3000). The demo server uses node-pty to spawn real shell sessions over WebSocket. Integration tests auto-start it via Playwright's `webServer` config, so you don't need to start it manually for `pnpm run test-integration`.

**Build before testing**: Always run `pnpm run build && pnpm run esbuild` before `pnpm run test-unit`. Integration tests also need `pnpm run esbuild-demo-client` and `pnpm run esbuild-demo-server`. The update script handles this automatically on session start.

**No external services**: This project has zero external dependencies (no databases, Docker, or APIs). Everything runs locally with Node.js.

**TypeScript compiler**: The project uses the TypeScript 7 `tsc` compiler.

**Lint only changed files**: Prefer `pnpm run lint-changes` over `pnpm run lint` when iterating on code changes — it's significantly faster.
