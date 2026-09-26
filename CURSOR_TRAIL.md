# Cursor trail

The optional cursor trail draws a short streak between the cursor's previous and
current positions when it jumps. It is a faithful reimplementation of the
built-in cursor trail in [kitty](https://github.com/kovidgoyal/kitty): the
motion, decay, start threshold, opacity and masking behaviour are taken from
kitty's `cursor_trail.c` and `shaders/trail.slang`, and the geometry is a
genuine four-corner quad (not a chain of axis-aligned rectangles), so diagonal
and concatenated jumps produce the same shape kitty produces.

It is implemented in the shared GPU renderer geometry, so both WebGL
(`@partty/addon-webgl`) and WebGPU (`@partty/addon-webgpu`) produce the same
result. The DOM renderer ignores the option.

The feature is **off by default** and allocates no animation frames or GPU
resources while disabled.

## Pinned research sources

The implementation was derived from kitty at commit
`78292b4286f17ed50d45b83b0d6491446573a440` (master, 2026-09-26):

- `kitty/cursor_trail.c` — https://github.com/kovidgoyal/kitty/blob/78292b4286f17ed50d45b83b0d6491446573a440/kitty/cursor_trail.c
- `kitty/shaders/trail.slang` — https://github.com/kovidgoyal/kitty/blob/78292b4286f17ed50d45b83b0d6491446573a440/kitty/shaders/trail.slang
- `kitty/state.h` (`CursorTrail`) — https://github.com/kovidgoyal/kitty/blob/78292b4286f17ed50d45b83b0d6491446573a440/kitty/state.h#L428
- `kitty/child-monitor.c` (scheduling) — https://github.com/kovidgoyal/kitty/blob/78292b4286f17ed50d45b83b0d6491446573a440/kitty/child-monitor.c#L891
- `kitty/screen.c` (`position_changed_by_client_at`) — https://github.com/kovidgoyal/kitty/blob/78292b4286f17ed50d45b83b0d6491446573a440/kitty/screen.c#L2752
- `kitty/gl.c` (`draw_quad`, premultiplied blend) — https://github.com/kovidgoyal/kitty/blob/78292b4286f17ed50d45b83b0d6491446573a440/kitty/gl.c#L120
- `kitty/graphics.h` (`gl_pos_x/y`, `gl_size`) — https://github.com/kovidgoyal/kitty/blob/78292b4286f17ed50d45b83b0d6491446573a440/kitty/graphics.h#L187
- Options: `kitty/options/definition.py` (L445-510), `kitty/options/utils.py` (L667-680)

No kitty source is copied into this MIT-licensed project; the equations in
`src/browser/renderer/shared/gpu/CursorTrailModel.ts` are an original
mathematical translation.

## API

The options are flat on `ITerminalOptions` (see `typings/xterm.d.ts`):

| Option | Type | Default | kitty equivalent |
| --- | --- | --- | --- |
| `cursorTrail` | `number` (ms, `0` disables) | `0` | `cursor_trail` |
| `cursorTrailDecay` | `[number, number]` (seconds, `[fast, slow]`) | `[0.1, 0.4]` | `cursor_trail_decay` |
| `cursorTrailStartThreshold` | `number \| [number, number]` (cells) | `2` | `cursor_trail_start_threshold` |
| `cursorTrailColor` | `string` (`'none'` = theme cursor color) | `'none'` | `cursor_trail_color` |

```ts
const term = new Terminal({ cursorTrail: 300 });
term.open(document.getElementById('terminal')!);
// later
term.options.cursorTrailDecay = [0.1, 0.4];
term.options.cursorTrailColor = '#80bfff';
```

Validation is intentionally small: `cursorTrail` is floored to a non-negative
integer (no arbitrary upper cap), decay values are non-negative and `slow` is
lifted to at least `fast`, thresholds are floored non-negative cell counts, and
the color must parse or `'none'`. Non-finite numbers fall back to their defaults
so the hot path never sees `NaN`.

## Behaviour and equivalence

### Motion

All motion is computed in normalized canvas coordinates (top-left origin, 0..1).
This is a uniform scale of kitty's NDC (bottom-left origin, -1..1), so every
direction, projection and dot product is mathematically identical; the x and y
scales remain independent, preserving the cell aspect ratio exactly as kitty
does. Each corner is eased toward the matching corner of the target rectangle:

```
center      = midpoint of the target rectangle
diag2       = 0.5 * length(target.right - target.left, target.bottom - target.top)
for each corner i:
    d_i     = target_corner_i - corner_i
    dot_i   = (d_i . (target_corner_i - center)) / diag2 / |d_i|
decay_i = slow + (fast - slow) * (dot_i - min_dot) / (max_dot - min_dot)
step    = 1 - 2^(-10 * dt / decay_i)
corner_i += d_i * step
```

`decay` is the time for the remaining distance to fall to `2^-10` (1/1024),
matching kitty's comment. Because the factor is multiplicative, the easing is
exactly additive in time, which is covered by a unit test. Corners decide the
decay by projecting their motion onto the direction from the cursor centre,
which makes the leading corners catch up faster than the trailing ones.

### Start threshold and settling

Below the start threshold the corners snap to the target so a small move starts
no trail; above it they animate. The animation keeps requesting frames until
every corner is within **half a device pixel** of its target (kitty's
`g.dx / cell_width * 0.5`), then stops. Target coordinates are rounded to
`Float32` once before being stored, so an unchanged fractional cursor position
does not spuriously register as a retarget.

The start-threshold comparison uses kitty's `round` (ties away from zero): the
implementation rounds the absolute delta, which is equivalent because `round` is
an odd function and avoids JavaScript's `Math.round` tie-toward-`+Infinity`
behaviour for negative half-cell moves.

### Opacity, hide and blink

Trail opacity rises toward 1 while the cursor is enabled and decays toward 0
over `cursorTrailDecay[1]` when it becomes unavailable. Hiding the cursor (DEC
private mode 25) fades the trail rather than hard-clearing it, exactly like
kitty. Blinking is deliberately **not** an input to the trail: the model is fed
the logical cursor geometry independently of blink state, so a blink never
resets motion. A hard `reset()` (which also forgets the observed cursor, so a
later theme/option change cannot schedule stale motion) is reserved for resize,
viewport hide, scroll and disposal.

### Trigger debounce

The trail only retargets once the cursor has been stationary for `cursorTrail`
milliseconds, mirroring kitty's `OPT(cursor_trail) <= now -
position_changed_by_client_at`. The timestamp is recorded **while parsing**, by
`InputHandler._notifyCursorExplicitPosition()`, at the exact kitty call sites of
`screen_cursor_position`: CUP/HVP and VPA. Ordinary printed text, C0 controls,
relative movement and CHA/HPA do not mark (kitty's `screen_cursor_to_column`
never touches the timestamp). DECRC is deliberately not marked: kitty only
records the timestamp on its invalid-savepoint fallback, which xterm.js cannot
distinguish from a real restore, so marking every restore would suppress trails
more often than kitty. Recording at parse time (rather than from a render
observation) means a whole batch of output cannot overwrite an intermediate
position's timestamp.

Scheduling is single-writer: `setCursor` only records the latest geometry and
schedules at most one pending tick; the tick is the only place that advances
motion and requests a redraw through the shared render service. That keeps the
model integrated exactly once per real frame with the real elapsed time, so
rapid `renderRows` calls neither double-advance the animation nor feed back into
extra redraws. Waiting out the debounce uses a single cancellable timeout whose
deadline is tracked and re-evaluated whenever the cursor or `stationaryMs`
changes (so rapid churn keeps exactly one bounded timer and lowering the delay
takes effect immediately); the timeout chunk is clamped to `2^31-1` ms because
`setTimeout` overflows larger delays, and the remaining time is re-checked when
the timer wakes. Opacity is advanced analytically on observation, attributed to
the *previous* visibility state, so a long visible idle ramps opacity before a
hide and a long hidden interval decays it before a show, without scheduling
frames. The first frame after a long idle uses `dt = 0` so the accepted target
animates instead of snapping. Synchronized output (DEC 2026) is never bypassed:
the model requests redraws through the normal service, which is free to defer
them, and never draws behind its back.

### Rendering

The trail is a four-corner quad drawn before glyphs and the live cursor. The
fragment shader masks the current cursor rectangle and outputs **premultiplied**
alpha, matching kitty:

```
inX = step(rect.left, pos.x) * step(pos.x, rect.right)
inY = step(rect.top,  pos.y) * step(pos.y, rect.bottom)
opacity = trailOpacity * (1 - inX * inY)
color = vec4(trailColor * opacity, opacity)
```

WebGL draws the four corners as a `TRIANGLE_FAN`; WebGPU has no fan topology, so
it submits the two triangles `(0,1,2)` and `(0,2,3)`, which fill the same area.
Both use premultiplied over blending (`ONE`, `ONE_MINUS_SRC_ALPHA`). Corner
order is `0=(right,top), 1=(right,bottom), 2=(left,bottom), 3=(left,top)`,
matching kitty's `corner_index` maps. `trailOpacity` is the animated opacity
multiplied by the resolved colour's alpha (a host extension; see deviations).

The GPU trail pipeline/program and the WebGPU vertex/uniform buffers are created
on the first trailed frame, so an unused trail has no GPU cost.

## Documented deviations from kitty

- **Coordinate space**: kitty works directly in NDC and renders with OpenGL.
  This implementation works in normalized canvas coordinates and projects
  through the shared backends. The two are related by a uniform scale, so the
  motion is identical.
- **Wide cursors**: kitty's block/hollow trail target is always one cell wide.
  xterm.js supports wide cells, so the target uses the real `cursor.width`
  bounds. This only matters for a wide character's cursor.
- **Inactive/outline cursor**: xterm.js can render an inactive cursor with the
  `outline` style (and `none`). `outline` is treated as the full cell rectangle;
  `none` provides no target and fades the trail. kitty has no direct `outline`
  equivalent.
- **Focus**: kitty keeps animating the active pane even when the OS window is
  unfocused. This implementation also does not reset on blur, but it cannot know
  whether a pane is the active one across panes; when the unfocused cursor style
  is `none` the trail simply fades.
- **Viewport scroll / hidden tab**: the trail is hard-cleared on viewport scroll
  and while the tab is hidden, to avoid animating across a scroll and to cancel
  frames for a hidden document.
- **Reduced motion**: `prefers-reduced-motion: reduce` disables the trail. This
  is a host accessibility behaviour (there is no per-terminal option to override
  it). kitty has no equivalent.
- **Auto-anti-aliasing**: the built-in trail is not anti-aliased in kitty and is
  not anti-aliased here either. The optional kitty custom shader styles (blaze,
  lightning) are intentionally out of scope.
- **Colour alpha (host extension)**: kitty's built-in trail ignores the alpha
  component of `cursor_trail_color` and uses RGB only. xterm.js instead folds the
  resolved colour's alpha into the rendered opacity, and a fully transparent
  colour disables the trail entirely (no scheduling, no GPU work). This is a
  deliberate host extension; an opaque colour reproduces kitty exactly.
- **DECRC timing**: kitty only records `position_changed_by_client_at` on the
  invalid-save fallback of DECRC; because xterm.js cannot distinguish a real
  restore from that fallback, DECRC does not mark at all. This is the closest
  faithful approximation and is noted here for independent review.
- **Parser mapping scope**: the built-in trail algorithm and geometry are 1:1,
  but the trigger timestamp is an approximation of kitty's exact parser call
  sites (CUP/HVP/VPA); the differences above are the only known ones.

## Source layout

- `src/common/CursorTrail.ts` — option sanitizers and the resolved hot-path shape.
- `src/common/Time.ts` — shared monotonic clock used by the parser and the model.
- `src/browser/renderer/shared/gpu/CursorTrailModel.ts` — the animation state
  machine and corner/opacity equations.
- `addons/addon-webgl/src/RectangleRenderer.ts` — WebGL trail program (lazy).
- `addons/addon-webgpu/src/WebgpuShaders.ts` / `WebgpuContext.ts` /
  `WebgpuBackend.ts` — WebGPU trail shader, lazy pipeline and buffers.
