/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IRenderDimensions } from 'browser/renderer/shared/Types';
import { IThemeService } from 'browser/services/Services';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { Terminal } from '@xterm/xterm';
import { RectangleRenderModel } from 'browser/renderer/shared/gpu/RectangleRenderModel';
import { IRectangleRenderer, ICursorTrailVertices, IRenderModel } from 'browser/renderer/shared/gpu/Types';
import { IWebGL2RenderingContext, IWebGLVertexArrayObject } from './Types';
import { createProgram, PROJECTION_MATRIX } from './WebglUtils';
import { throwIfFalsy } from 'browser/renderer/shared/RendererUtils';
import type { ILogService } from 'common/services/Services';

const enum VertexAttribLocations {
  POSITION = 0,
  SIZE = 1,
  COLOR = 2,
  UNIT_QUAD = 3,
  TRAIL_POSITION = 0
}

const vertexShaderSource = `#version 300 es
layout (location = ${VertexAttribLocations.POSITION}) in vec2 a_position;
layout (location = ${VertexAttribLocations.SIZE}) in vec2 a_size;
layout (location = ${VertexAttribLocations.COLOR}) in vec4 a_color;
layout (location = ${VertexAttribLocations.UNIT_QUAD}) in vec2 a_unitquad;

uniform mat4 u_projection;

out vec4 v_color;

void main() {
  vec2 zeroToOne = a_position + (a_unitquad * a_size);
  gl_Position = u_projection * vec4(zeroToOne, 0.0, 1.0);
  v_color = a_color;
}`;

const fragmentShaderSource = `#version 300 es
precision lowp float;

in vec4 v_color;

out vec4 outColor;

void main() {
  outColor = v_color;
}`;

// The cursor trail draws a genuine four-corner quad; positions are normalized
// against the device canvas and passed straight through the projection. The
// fragment stage masks the current cursor rectangle and outputs premultiplied
// alpha, matching kitty's built-in trail shader.
const trailVertexShaderSource = `#version 300 es
layout (location = ${VertexAttribLocations.TRAIL_POSITION}) in vec2 a_position;

uniform mat4 u_projection;

out vec2 v_position;

void main() {
  v_position = a_position;
  gl_Position = u_projection * vec4(a_position, 0.0, 1.0);
}`;

const trailFragmentShaderSource = `#version 300 es
precision highp float;

in vec2 v_position;

uniform vec4 u_cursor_rect;
uniform vec3 u_color;
uniform float u_opacity;

out vec4 outColor;

void main() {
  float insideX = step(u_cursor_rect.x, v_position.x) * step(v_position.x, u_cursor_rect.z);
  float insideY = step(u_cursor_rect.y, v_position.y) * step(v_position.y, u_cursor_rect.w);
  float opacity = u_opacity * (1.0 - insideX * insideY);
  outColor = vec4(u_color * opacity, opacity);
}`;

const enum Constants {
  BYTES_PER_RECTANGLE = 8 * 4,
  FLOATS_PER_RECTANGLE = 8
}

export class RectangleRenderer extends Disposable implements IRectangleRenderer {
  private readonly _program: WebGLProgram;
  private readonly _vertexArrayObject: IWebGLVertexArrayObject;
  private readonly _attributesBuffer: WebGLBuffer;
  private readonly _projectionLocation: WebGLUniformLocation;
  private readonly _model: RectangleRenderModel;

  // Trail resources are created on first use so an unused trail costs nothing.
  private _trailProgram: WebGLProgram | undefined;
  private _trailVertexArrayObject: IWebGLVertexArrayObject | undefined;
  private _trailBuffer: WebGLBuffer | undefined;
  private _trailProjectionLocation: WebGLUniformLocation | undefined;
  private _trailCursorRectLocation: WebGLUniformLocation | undefined;
  private _trailColorLocation: WebGLUniformLocation | undefined;
  private _trailOpacityLocation: WebGLUniformLocation | undefined;

  constructor(
    terminal: Terminal,
    private readonly _gl: IWebGL2RenderingContext,
    dimensions: IRenderDimensions,
    themeService: IThemeService,
    private readonly _logService: ILogService
  ) {
    super();
    const gl = this._gl;

    this._program = throwIfFalsy(createProgram(gl, vertexShaderSource, fragmentShaderSource, this._logService));
    this._register(toDisposable(() => gl.deleteProgram(this._program)));

    this._projectionLocation = throwIfFalsy(gl.getUniformLocation(this._program, 'u_projection'));

    const vertexArrayObject = this._vertexArrayObject = gl.createVertexArray();
    this._register(toDisposable(() => gl.deleteVertexArray(vertexArrayObject)));
    gl.bindVertexArray(vertexArrayObject);

    const unitQuadVertices = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
    const unitQuadVerticesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(unitQuadVerticesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuadVerticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, unitQuadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(VertexAttribLocations.UNIT_QUAD);
    gl.vertexAttribPointer(VertexAttribLocations.UNIT_QUAD, 2, gl.FLOAT, false, 0, 0);

    const unitQuadElementIndices = new Uint8Array([0, 1, 2, 3]);
    const elementIndicesBuffer = gl.createBuffer();
    this._register(toDisposable(() => gl.deleteBuffer(elementIndicesBuffer)));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, elementIndicesBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, unitQuadElementIndices, gl.STATIC_DRAW);

    this._attributesBuffer = throwIfFalsy(gl.createBuffer());
    this._register(toDisposable(() => gl.deleteBuffer(this._attributesBuffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    gl.enableVertexAttribArray(VertexAttribLocations.POSITION);
    gl.vertexAttribPointer(VertexAttribLocations.POSITION, 2, gl.FLOAT, false, Constants.BYTES_PER_RECTANGLE, 0);
    gl.vertexAttribDivisor(VertexAttribLocations.POSITION, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.SIZE);
    gl.vertexAttribPointer(VertexAttribLocations.SIZE, 2, gl.FLOAT, false, Constants.BYTES_PER_RECTANGLE, 2 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.SIZE, 1);
    gl.enableVertexAttribArray(VertexAttribLocations.COLOR);
    gl.vertexAttribPointer(VertexAttribLocations.COLOR, 4, gl.FLOAT, false, Constants.BYTES_PER_RECTANGLE, 4 * Float32Array.BYTES_PER_ELEMENT);
    gl.vertexAttribDivisor(VertexAttribLocations.COLOR, 1);

    this._model = this._register(new RectangleRenderModel(terminal, dimensions, themeService));
  }

  public renderBackgrounds(): void {
    this._renderVertices(this._model.backgrounds);
  }

  public renderCursor(): void {
    this._renderVertices(this._model.cursor);
  }

  public renderCursorTrail(vertices: ICursorTrailVertices): void {
    if (!vertices.visible || vertices.opacity <= 0) {
      return;
    }
    this._ensureTrailResources();
    const gl = this._gl;
    gl.useProgram(this._trailProgram!);
    gl.bindVertexArray(this._trailVertexArrayObject!);
    gl.uniformMatrix4fv(this._trailProjectionLocation!, false, PROJECTION_MATRIX);
    gl.uniform4f(this._trailCursorRectLocation!, vertices.cursorRect[0], vertices.cursorRect[1], vertices.cursorRect[2], vertices.cursorRect[3]);
    gl.uniform3f(this._trailColorLocation!, vertices.color[0], vertices.color[1], vertices.color[2]);
    gl.uniform1f(this._trailOpacityLocation!, vertices.opacity);
    // Premultiplied source over destination, matching kitty.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._trailBuffer!);
    gl.bufferData(gl.ARRAY_BUFFER, vertices.positions, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }

  private _ensureTrailResources(): void {
    if (this._trailProgram) {
      return;
    }
    const gl = this._gl;
    const program = this._trailProgram = throwIfFalsy(createProgram(gl, trailVertexShaderSource, trailFragmentShaderSource, this._logService));
    this._register(toDisposable(() => gl.deleteProgram(program)));
    this._trailProjectionLocation = throwIfFalsy(gl.getUniformLocation(program, 'u_projection'));
    this._trailCursorRectLocation = throwIfFalsy(gl.getUniformLocation(program, 'u_cursor_rect'));
    this._trailColorLocation = throwIfFalsy(gl.getUniformLocation(program, 'u_color'));
    this._trailOpacityLocation = throwIfFalsy(gl.getUniformLocation(program, 'u_opacity'));

    const vao = this._trailVertexArrayObject = gl.createVertexArray();
    this._register(toDisposable(() => gl.deleteVertexArray(vao)));
    gl.bindVertexArray(vao);
    const buffer = this._trailBuffer = throwIfFalsy(gl.createBuffer());
    this._register(toDisposable(() => gl.deleteBuffer(buffer)));
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(VertexAttribLocations.TRAIL_POSITION);
    gl.vertexAttribPointer(VertexAttribLocations.TRAIL_POSITION, 2, gl.FLOAT, false, 0, 0);
  }

  private _renderVertices(vertices: { attributes: Float32Array, count: number }): void {
    if (vertices.count === 0) {
      return;
    }
    const gl = this._gl;
    gl.useProgram(this._program);
    gl.bindVertexArray(this._vertexArrayObject);
    gl.uniformMatrix4fv(this._projectionLocation, false, PROJECTION_MATRIX);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._attributesBuffer);
    // Upload only the used rectangles rather than the full backing capacity.
    gl.bufferData(gl.ARRAY_BUFFER, vertices.attributes.subarray(0, vertices.count * Constants.FLOATS_PER_RECTANGLE), gl.DYNAMIC_DRAW);
    gl.drawElementsInstanced(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0, vertices.count);
  }

  public handleResize(): void {
    this._model.handleResize();
  }

  public setDimensions(dimensions: IRenderDimensions): void {
    this._model.setDimensions(dimensions);
  }

  public updateBackgrounds(model: IRenderModel, startRow: number, endRow: number): void {
    this._model.updateBackgrounds(model, startRow, endRow);
  }

  public updateCursor(model: IRenderModel): void {
    this._model.updateCursor(model);
  }
}
