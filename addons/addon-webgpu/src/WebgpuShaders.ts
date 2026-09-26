/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

const quadSource = `
fn quad(vertex: u32) -> vec2f {
  return vec2f(f32(vertex & 1u), f32(vertex >> 1u));
}

fn clip(position: vec2f) -> vec4f {
  return vec4f(2.0 * position.x - 1.0, 1.0 - 2.0 * position.y, 0.0, 1.0);
}
`;

export function createGlyphShader(maxAtlasPages: number): string {
  let textures = '';
  let cases = '';
  for (let i = 0; i < maxAtlasPages; i++) {
    textures += `@group(0) @binding(${i + 2}) var page${i}: texture_2d<f32>;\n`;
    // Explicit LOD avoids derivative-uniformity requirements in the page switch.
    cases += `case ${i}u: { return textureSampleLevel(page${i}, atlasSampler, input.uv, 0.0); }\n`;
  }
  return `${quadSource}
// viewport.xy is the rasterization viewport size (the intended grid clamped to
// the attachment, which WebGPU requires the viewport to stay within), and
// viewport.zw is intendedGrid / viewport. offset is in device pixels so it is
// normalized by the viewport size; cell and size are grid units normalized by
// the intended grid, so they are scaled together by viewport.zw. This keeps
// every glyph at its exact intended device pixel position (offset + x*cellW +
// unit*glyphSize) for any backing size, clipping only the final edge when the
// attachment is smaller than the grid.
@group(0) @binding(0) var<uniform> viewport: vec4f;
@group(0) @binding(1) var atlasSampler: sampler;
${textures}
struct GlyphOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) page: u32,
}

@vertex fn vs(
  @builtin(vertex_index) vertex: u32,
  @location(0) offset: vec2f,
  @location(1) size: vec2f,
  @location(2) page: f32,
  @location(3) uv: vec2f,
  @location(4) uvSize: vec2f,
  @location(5) cell: vec2f
) -> GlyphOutput {
  let unit = quad(vertex);
  var output: GlyphOutput;
  output.position = clip(offset / viewport.xy + (cell + unit * size) * viewport.zw);
  output.uv = uv + unit * uvSize;
  output.page = u32(page);
  return output;
}

@fragment fn fs(input: GlyphOutput) -> @location(0) vec4f {
  switch input.page {
    ${cases}
    default: { return vec4f(0.0); }
  }
}
`;
}

export const rectangleShader = `${quadSource}
// position and size are grid units normalized by the intended grid, so the
// whole quad is scaled by viewport.zw to land at exact device pixels, matching
// the glyph shader's transform for the same viewport.
@group(0) @binding(0) var<uniform> viewport: vec4f;
struct RectangleOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
}

@vertex fn vs(
  @builtin(vertex_index) vertex: u32,
  @location(0) position: vec2f,
  @location(1) size: vec2f,
  @location(2) color: vec4f
) -> RectangleOutput {
  var output: RectangleOutput;
  output.position = clip((position + quad(vertex) * size) * viewport.zw);
  output.color = vec4f(color.rgb * color.a, color.a);
  return output;
}

@fragment fn fs(input: RectangleOutput) -> @location(0) vec4f {
  return input.color;
}
`;

// Cursor trail. A genuine four-corner quad is submitted as two triangles
// (0,1,2 and 0,2,3) so the fill matches kitty's GL_TRIANGLE_FAN. The fragment
// stage masks the current cursor rectangle and outputs premultiplied alpha.
export const trailShader = `${quadSource}
struct TrailUniforms {
  cursorRect: vec4f,
  color: vec4f,
  opacity: f32,
}
@group(0) @binding(0) var<uniform> trail: TrailUniforms;

struct TrailOutput {
  @builtin(position) position: vec4f,
  @location(0) pos: vec2f,
}

@vertex fn vs(
  @builtin(vertex_index) vertex: u32,
  @location(0) corner: vec2f
) -> TrailOutput {
  var output: TrailOutput;
  output.position = clip(corner);
  output.pos = corner;
  return output;
}

@fragment fn fs(input: TrailOutput) -> @location(0) vec4f {
  let insideX = step(trail.cursorRect.x, input.pos.x) * step(input.pos.x, trail.cursorRect.z);
  let insideY = step(trail.cursorRect.y, input.pos.y) * step(input.pos.y, trail.cursorRect.w);
  let opacity = trail.opacity * (1.0 - insideX * insideY);
  return vec4f(trail.color.rgb * opacity, opacity);
}
`;
