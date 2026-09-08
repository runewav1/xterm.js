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
@group(0) @binding(0) var<uniform> resolution: vec2f;
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
  output.position = clip(offset / resolution + cell + unit * size);
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
  output.position = clip(position + quad(vertex) * size);
  output.color = vec4f(color.rgb * color.a, color.a);
  return output;
}

@fragment fn fs(input: RectangleOutput) -> @location(0) vec4f {
  return input.color;
}
`;
