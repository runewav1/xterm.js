# Cursor smear

The optional cursor smear trails the terminal cursor with a short, fading ghost
when it moves. It is implemented directly in the shared GPU renderer geometry,
so both the WebGL (`@partty/addon-webgl`) and WebGPU (`@partty/addon-webgpu`)
renderers support it with the same appearance and options. The DOM renderer
ignores the option.

The feature is **off by default** and uses no animation frames while disabled.

## Enabling at runtime

```ts
import { Terminal } from '@partty/xterm';
import { WebglAddon } from '@partty/addon-webgl';

const term = new Terminal();
term.open(document.getElementById('terminal')!);
term.loadAddon(new WebglAddon());

term.options.cursorSmear = {
  enabled: true,
  duration: 140,
  style: 'trail',
  samples: 5,
  opacity: 0.45,
  easing: 'easeOut',
  endScale: 0.6
};
```

Assign a new object to change any setting at runtime, mirroring how
`term.options.theme` is replaced. Reassigning fires the option change and the
renderer picks the new values up on the next frame.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Master switch. |
| `duration` | `number` | `120` | Animation length in milliseconds, clamped to `0..5000`. |
| `style` | `'fade' \| 'trail'` | `'trail'` | `'fade'` is a single fading ghost at the previous position; `'trail'` is a composed tail. |
| `samples` | `number` | `4` | Ghost count for `'trail'`, clamped to `1..16`. |
| `opacity` | `number` | `0.5` | Base opacity, clamped to `0..1`. |
| `color` | `string` | theme cursor | Color accepted by xterm's color parser (for example `#80bfff` or `#80bfff80`); overrides the theme cursor color. |
| `easing` | `'linear' \| 'easeOut' \| 'easeInOut'` | `'easeOut'` | Position interpolation. |
| `minDistance` | `number` | `1` | Minimum travel in cells before a smear starts. |
| `maxDistance` | `number` | `0` | Maximum travel in cells; `0` means unlimited. |
| `endScale` | `number` | `1` | Scale of the oldest ghost for a taper; `1` disables it. |
| `respectReducedMotion` | `boolean` | `true` | Disables the smear when the OS requests reduced motion. |

## Behaviour

- The trail is generated as instanced rectangles in the shared GPU rectangle
  pipeline; no shaders change between renderers.
- The trail is clipped around the live block cursor and drawn before glyphs and
  the live cursor, so text and the cursor stay legible.
- Rapid cursor retargets continue from the currently rendered position instead
  of teleporting the trail.
- The smear hard clears when the cursor is hidden, blinking off, blurred,
  scrolled out of the viewport, resized, or when the buffer/alternate screen
  changes. No residual trail remains in those states.
- `prefers-reduced-motion: reduce` disables the smear unless
  `respectReducedMotion` is `false`.
