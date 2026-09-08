# Native State Ingress Proposal

Status: engineering proposal, not an implemented or existing public xterm API.
Scope: Rust owns semantics; xterm is a synchronous read-model for DOM/WebGL/WebGPU.
No speedup has been measured. WebGPU changes rendering; it does not remove VT parsing.

## Research Baseline

Paths below are relative to this xterm repository; `../main/` denotes the adjacent
ParTTY checkout inspected read-only. Symbol names identify the relevant code.

- `typings/xterm.d.ts`: `Terminal.write` accepts strings/bytes; buffer APIs are
  read-only. `src/browser/public/Terminal.ts`: `write` delegates to the core;
  `refresh` only requests repaint. There is no public snapshot/delta ingress.
- `src/common/CoreTerminal.ts`: `WriteBuffer` invokes `InputHandler.parse`;
  `src/common/InputHandler.ts` performs terminal mutations and emits side effects.
  `write(Uint8Array)` still decodes/parses terminal output, despite binary transport.
- `src/common/services/BufferService.ts`: owns dimensions and `BufferSet`;
  `src/common/buffer/Buffer.ts`: `resize`, `_reflow`, and `addMarker` couple history, geometry, and line lifecycle.
- `src/browser/renderer/dom/DomRenderer.ts`: `renderRows` reads `buffer.lines` at
  `ydisp`; `src/browser/renderer/shared/gpu/GpuRenderer.ts` reads lines and `loadCell`.
  `src/browser/renderer/shared/Types.ts`: `IRenderer` is a downstream draw contract.
  The experimental WebGPU addon consumes this same model; it does not import native state.
- `src/common/public/BufferApiView.ts` and `src/browser/services/SelectionService.ts`:
  synchronous buffer/text reads and lifecycle subscriptions rule out a renderer-only grid.

### ParTTY Today

- `../main/package.json`: uses beta xterm/WebGL/fit/serialize/image/ligatures/Unicode
  addons, not a declared local native-ingress dependency.
- `../main/src-tauri/src/pty.rs`: `PtySession` batches output; `OscStripper` extracts
  metadata/clipboard operations. The emitter sends cleaned `InvokeResponseBody::Raw`
  bytes and separate `pty-cwd`, `pty-title`, and `pty-shell-event` events; OSC 52
  queries can reply directly to the PTY. This is not an authoritative terminal grid.
- `../main/src/pty/ptyIpc.ts`: `PtyOutputChannel` is `Channel<ArrayBuffer>`;
  `ptyEnsure` reattaches it by stable session ID. In `../main/src/main.ts`, the
  channel callback calls `deliverDirectPtyOut`; `processPtyOutputBatch` calls
  `pt.term.write(data)`. Its synchronous write timing is not completed rendering.
- `../main/src-tauri/src/pty.rs`: `replay_snapshot` clones bounded byte history;
  `../main/src/main.ts`: `replayBackendSnapshotOnce` calls `term.write` with it.
  This "snapshot" is not a complete semantic checkpoint.
- `../main/src/main.ts`: `runLayoutPassForHost` calls `pt.fit.fit()` before
  `ptyResizeBatch`; `../main/src-tauri/src/pty.rs`: `PtySession::resize` resizes the
  PTY. Today JS terminal geometry and PTY geometry are updated separately.
- `../main/src/terminal/termLifecycle.ts`: defaults shed WebGL/destroy the webview
  on hide. Rust retains/retries bounded pending bytes, not revision-based state.
  `../main/src/terminal/paneHost.ts` loads Unicode/grapheme addons: width and addon
  compatibility are migration requirements.

## Candidate Boundaries

| Boundary | Assessment |
| --- | --- |
| Generate ANSI and call `write` | Useful compatibility/control path; retains JS parsing and two semantic implementations. Not native state ingress. |
| Addon pokes `_core` / `BufferLine` internals | Small experiment, brittle lifecycle/cache/event invariants; not a supported production interface. |
| Fork-owned transactional `BufferService` ingress | Recommended first implementation: reuse buffer readers/renderers, bypass parser and native-state reflow. Requires core and browser integration. |
| Replace `IBufferService` with a packed read-model | Possible later optimization; must satisfy synchronous readers and lifecycle expectations, not just renderer methods. |
| Feed GPU instances directly | Rendering experiment only; otherwise duplicates selection, search, accessibility, links, and buffer APIs. |

Proposed flow: `PTY -> Rust terminal -> versioned binary snapshots/deltas -> validated transaction -> synchronous xterm buffer read-model -> renderer`.
Start with an opt-in, mutually exclusive native-state mode in a maintained fork.
Reject `write`, parser-driven mutations, local reset/clear/reflow, and semantic
option changes in that mode, or route them explicitly to Rust. No mixed writers.
Worker decoding is possible; synchronous buffer reads must never await IPC.

## Ownership And Resize

Rust owns parsing/decoder state, cursor/saved cursor/wrap-pending state, both screens,
margins, tabs, modes, Unicode widths/graphemes, erase/scroll/reflow, history, palette
changes, and replies. Parser-private state stays native; export all reader/input-visible state.
JS owns DOM focus/IME, metrics/DPR, layout requests, selection/viewport intent,
theme defaults, decorations, and rendering. Keep application palette overrides separate.

Prefer structured key/mouse/paste/focus input encoded by Rust with authoritative modes.
An interim xterm encoder needs atomically mirrored cursor/keypad, bracketed paste,
focus, mouse, and platform modes plus input/output ordering to prevent stale encoding.
Terminal-generated replies have one native owner, never both Rust and xterm.

Resize: JS measures desired cells without `fit()` mutating the buffer and sends a
request ID/dimensions. Rust serializes resize with PTY reads/input, applies terminal
reflow and PTY resize, then publishes geometry revision, request ID, dimensions/state.
Report PTY resize failure and reconcile geometry, not half-success. JS commits without
`Buffer.resize` reflow, then updates renderer/viewport/accessibility. Retain the old
grid while waiting; reject mismatched-geometry deltas. Coalesce only unsent requests.

## State Contract

Use a documented little-endian wire schema, not Rust struct memory or xterm's
private packed ABI. Header: magic, schema/capabilities, session ID, native epoch,
attachment generation, frame kind/length, base revision, target revision,
geometry revision, and event sequence range. Revisions must not lose JS integer
precision. A delta applies only to its exact base; a snapshot establishes a base.

- Snapshot both screens and retained normal history, active screen, dimensions,
  cursor position/style/visibility, modes, palette, current metadata, and stable
  line IDs with wrap flags. Include history origin/count and cursor/base offsets;
  local `ydisp` derives from the user's viewport anchor, not the native cursor.
- Cells carry empty-versus-space identity, full Unicode scalar or grapheme string,
  authoritative width, and width-zero continuation cells. Preserve combining
  marks, ZWJ/variation sequences, wide-cell boundaries, and wrap semantics;
  never recompute widths in JS or truncate graphemes to a single code point.
- Preserve default/indexed/RGB foreground/background, inverse, bold, dim, italic,
  blink, invisible, strike, overline, protected, and underline style/color/variant.
  `src/common/buffer/CellData.ts`, `src/common/buffer/AttributeData.ts`, and
  `src/common/buffer/BufferLine.ts`: three words omit combined strings and sparse attributes.
  Translate through an adapter; invalidate line text caches and stale side tables.
- Link definitions include stable native ID, URI, and OSC 8 ID/parameters; map
  them to local IDs and track lifetime across retained lines and both screens.
  `src/common/services/OscLinkService.ts` currently ties link GC to markers;
  `src/browser/OscLinkProvider.ts` needs resolvable metadata, not numeric IDs alone.
- `ExtendedAttrs.payload` is an object, not a portable binary field. Define typed,
  bounded capability sections for image/custom payloads or reject those features
  explicitly. Parser-dependent addons need native equivalents or declared limits.

Initially use complete changed rows and explicit append/trim/insert/delete/screen-switch
operations. Retain advertised history locally for synchronous copy/search/public reads.
Lazy history needs a separate API, not fake blank rows. Stage validation/allocation;
commit state and bookkeeping atomically before notifying consumers.

## Events And Local State

Snapshots cannot reconstruct transient effects. Journal title/CWD/shell events, bell,
accessibility characters/tabs/line feeds, and authorized host requests by revision/sequence.
Commit referenced state before ordered delivery; retain transaction boundaries when
consumers require intermediate state. Deduplicate replay by sequence; snapshots restore
metadata without reannouncing history or repeating clipboard actions/replies.

`src/browser/CoreBrowserTerminal.ts` currently forwards `InputHandler` events;
`src/browser/AccessibilityManager.ts` consumes both rendered buffer text and
`onA11yChar`/`onA11yTab`/line-feed events. Import must supply both paths, including
echo suppression. Do not infer announcements from changed cells. Native replies
must proceed without rendering; host-dependent queries need ordered request IDs,
permission checks, and a defined unavailable/timeout policy while hidden.

Anchor selection/scroll position to stable lines/cell offsets. Follow output only
at bottom; preserve scrolled-up text through append/trim. Map anchors through reflow
or explicitly clear unmappable selection. Preserve surviving markers/decorations;
move/dispose exactly once on insert/delete/trim/reset. `Buffer.addMarker` subscribes
to line-list events: wholesale replacement needs rebinding. Publish activation,
resize, scroll, cursor, and invalidation after consistent state; test reentrancy.
Recovery must reconcile anchors/markers, not attach them to unrelated numeric rows.

## Acknowledgements And Lifecycle

Define proposed `applied(epoch, revision)` after validation, atomic commit, and required
notifications: synchronous reads now observe that state. Track event delivery separately.
Use applied acknowledgements for transport credit, not animation frames/`onWriteParsed`.
Define `rendered(epoch, revision, viewportGeneration)` only after drawing the
current viewport with all accumulated damage through that revision. It means draw
submission/DOM update, not GPU completion or display presentation. Coalescing may
skip intermediate renders; unrelated cursor/theme redraws cannot acknowledge
unapplied content. Existing `onRender` carries rows, not revision guarantees.

`src/browser/services/RenderService.ts` pauses via IntersectionObserver and buffers
synchronized output. Hidden views may apply without rendering; suspended/destroyed
webviews cannot acknowledge. Rust continues parsing with bounded history/event retention,
stops obsolete visual deltas, and snapshots on reattach. Negotiate event replay/gaps
explicitly, never silently drop effects. Reject stale attachments; atomically subscribe
at the snapshot revision and queue later deltas. Resume with full viewport damage;
never gate PTY draining on a hidden-view render acknowledgement.

## Transport And Performance

Before mutation validate lengths/offsets with checked arithmetic, dimensions/history,
UTF-8, enums, wide cells, references, revisions, and capabilities. Bound frame bytes,
decoded allocation, queues, strings, and events. Reject malformed frames atomically;
resync on gaps. Treat data as untrusted: check link schemes/clipboard permissions,
never deserialize executable objects or insert terminal strings as HTML.
Discard duplicates; merge only dependency-preserving deltas or replace queued visuals
with a snapshot while retaining ordered events. Never drop arbitrary base deltas.
Chunk snapshots into bounded staging; commit when complete and cancel obsolete transfers.

Binary IPC already exists in ParTTY. Savings would come from avoiding JS semantics,
not merely changing transport/GPU API. State frames can exceed compact VT streams:
three words alone cost 12 bytes/cell before strings, links, history, and framing.
Measure Rust parsing/encoding, IPC bytes/copies, decode/apply/GC, renderer work,
total CPU/RSS, input and hide/resume latency. Compare row deltas, scroll operations,
bulk copies, and snapshots against raw `write` on identical traces. Batching trades
overhead for latency; compression/workers add CPU/copies. Optimize measured bottlenecks.

## Phases And Exit Criteria

1. Specify schema, ownership, supported VT/addon matrix, and latency/memory budgets;
   capture raw-path baselines. Build a Rust shadow oracle without duplicate replies.
2. Prototype full snapshots with existing buffers/DOM/WebGL. Exit: deterministic state,
   resize/events/copy/search/markers/links/accessibility parity, without private app pokes.
3. Add deltas, revision/event acknowledgements, bounded flow control, and reattach.
   Exit: no divergence, duplicate effects, deadlocks, or unbounded memory under fuzzed
   truncation/reordering/gaps, rapid resize, hidden/destroyed views, and bursts.
4. Profile before bulk layouts or further GPU changes. Ship opt-in only when p95/p99 latency/memory
   budgets pass and end-to-end benefit is measured. Roll back via a fresh terminal/session
   handoff, never mixed writes; specify migration for existing byte/ANSI restore data.

Unit/property-test codec and transactions. Differential replay compares cells, history,
wraps, modes, palette, cursor, links, events, and replies, not screenshots alone.
Cover split UTF-8/escapes, graphemes, wide-cell edits, alternate screens, scroll regions,
retention/reflow, synchronized output, and reentrancy. Browser-test DOM/WebGL copy/search,
screen readers, input modes, resize races, context loss, and renderer switching; repeat
on WebGPU. Test lifecycle in actual ParTTY WebView2. Record intentional
semantic differences; correctness failures block rollout regardless of throughput.
