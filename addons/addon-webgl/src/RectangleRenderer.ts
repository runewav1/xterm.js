/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { IRenderDimensions } from 'browser/renderer/shared/Types';
import { IThemeService } from 'browser/services/Services';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { Terminal } from '@xterm/xterm';
import { RectangleRenderModel } from 'browser/renderer/shared/gpu/RectangleRenderModel';
import { IRectangleRenderer, IRenderModel } from 'browser/renderer/shared/gpu/Types';
import { IWebGL2RenderingContext, IWebGLVertexArrayObject } from './Types';
import { createProgram, PROJECTION_MATRIX } from './WebglUtils';
import { throwIfFalsy } from 'browser/renderer/shared/RendererUtils';
import type { ILogService } from 'common/services/Services';

const enum VertexAttribLocations {
  POSITION = 0,
  SIZE = 1,
  COLOR = 2,
  UNIT_QUAD = 3
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

  constructor(
    terminal: Terminal,
    private readonly _gl: IWebGL2RenderingContext,
    dimensions: IRenderDimensions,
    themeService: IThemeService,
    logService: ILogService
  ) {
    super();
    const gl = this._gl;

    this._program = throwIfFalsy(createProgram(gl, vertexShaderSource, fragmentShaderSource, logService));
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
