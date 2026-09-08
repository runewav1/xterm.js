# Experimental WebGPU Renderer

Fork-specific `@partty/addon-webgpu`, alongside (not layered over) WebGL. It bundles
the shared CPU rasterizer/model, but no WebGL implementation. This is a working
experiment, not a claim that WebGPU is faster on every device or workload.

```ts
import { WebgpuAddon } from '@partty/addon-webgpu';

const addon = await WebgpuAddon.create();
addon.onError(error => console.error('WebGPU fell back to DOM', error));
addon.onContextLoss(() => console.warn('WebGPU device lost; using DOM'));
try {
  terminal.loadAddon(addon);
} catch (error) {
  addon.dispose();
  throw error;
}
```

Creation acquires a device asynchronously; activation is synchronous and can be
deferred until `terminal.open()`. Dispose an acquired addon if the pane disappears
while awaiting creation. Each addon owns its device. Loss and render failures
restore DOM only if this addon still owns the renderer; a later renderer is not
replaced. Dispose obsolete addons to release devices even after renderer replacement.
Initialization failures leave the existing renderer intact.

## Rendering Path

- Persistent instanced-quad buffers and cached full-viewport GPU geometry.
- Adjacent dirty glyph rows are coalesced into buffer uploads. Unchanged glyph
  rows are not recopied or re-uploaded each frame.
- One ordered render pass: backgrounds, colored atlas glyphs, then non-block cursor.
- Separately sized atlas textures, changed-page uploads, and a single ordered
  glyph draw. No page sorting, readback, per-cell GPU calls, or per-frame pipelines.
- Premultiplied-alpha presentation/blending supports transparent terminals.
- Shared glyph/color/cursor/selection logic with WebGL, renderer-scoped atlas
  ownership, and cache-keyed device limits. Links retain a small Canvas2D overlay.

The CPU still parses VT output, resolves cells and rasterizes new glyphs. Atlas
updates copy whole changed pages, backgrounds are rebuilt when the model changes,
and even empty cells consume degenerate GPU instances. These are measurement
targets, not solved bottlenecks. Rust-native state ingress is a separate proposal
in [native-state-ingress.md](../../docs/native-state-ingress.md).

## Shared session for many panes

`WebgpuAddon.create()` gives each terminal its own device. For multi-pane
applications, `WebgpuSession.create()` creates one shared device + context per
webview; call `session.createAddon()` once per terminal. All panes share the
pipelines, sampler and — key for memory — the GPU glyph-atlas textures: a glyph
atlas is uploaded to the GPU once per config and sampled by every pane instead
of being duplicated per terminal. Per-pane backends keep only their canvas
context, swapchain and content vertex buffers. Device loss and validation errors
are surfaced by the session and every pane addon restores DOM.

## Validation

```sh
pnpm run build && pnpm run esbuild
pnpm run test-unit
pnpm run esbuild-demo-client && pnpm run esbuild-demo-server
pnpm run test-integration --suite=addon-webgpu --workers=1
pnpm run test-integration --suite=addon-webgl --project=Chromium --workers=1
pnpm run lint-changes
```

The WebGPU suite uses full Chromium (`channel: 'chromium'`), not the standalone
headless shell, which may expose `navigator.gpu` without an available adapter.
Tests fail if WebGPU is unavailable or silently falls back. On this Windows/Intel
adapter: 73 WebGPU browser tests (including a shared-session multi-pane test) and
62 WebGL tests passed; each suite inherits nine skipped shared tests. Unit suite:
2,355 passed, 71 pending. This does not establish performance or parity on
WebView2, Safari, Firefox, or other drivers.

## ParTTY integration

The fork publishes `@partty/addon-webgl` and `@partty/addon-webgpu` to npm as
built bundles (UMD + ESM, typings, README — like xterm.js does). They are
compatible with `@xterm/xterm@6.1.0-beta.304` (the exact commit this fork's
core matches), so ParTTY keeps the official xterm core and installs our two
renderer addons:

```json
"dependencies": {
  "@xterm/xterm": "6.1.0-beta.304",
  "@partty/addon-webgl": "0.20.0",
  "@partty/addon-webgpu": "0.1.0"
}
```

ParTTY adds an experimental "Enable WebGPU renderer" option (default off →
WebGL). When enabled, it creates one `WebgpuSession` per webview and a session
addon per pane, and never falls back to WebGL while enabled.

Compare WebGL and WebGPU in the same WebView2, with the same traces, terminal
dimensions, font, DPR, transparency, and power mode. Measure cold atlas/startup,
steady scroll, sparse cursor/TUI updates, ligatures, selection, images, split panes,
resize storms, and destroy/recreate on hide. Record main-thread CPU, input latency,
p50/p95/p99 frame times, GPU time and memory. Submission timing alone is not display
latency; do not compare the duration of these correctness suites as a benchmark.
