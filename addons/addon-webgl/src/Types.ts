/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

export interface IWebGL2RenderingContext extends WebGLRenderingContext {
  vertexAttribDivisor(index: number, divisor: number): void;
  createVertexArray(): IWebGLVertexArrayObject;
  deleteVertexArray(vao: IWebGLVertexArrayObject): void;
  bindVertexArray(vao: IWebGLVertexArrayObject): void;
  drawElementsInstanced(mode: number, count: number, type: number, offset: number, instanceCount: number): void;
}

export interface IWebGLVertexArrayObject {
}
