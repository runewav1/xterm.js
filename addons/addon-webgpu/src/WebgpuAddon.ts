/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import type { IWebgpuAddonOptions, WebgpuAddon as IWebgpuApi, WebgpuSession as IWebgpuSessionApi } from '@partty/addon-webgpu';
import type { ITerminal } from 'browser/Types';
import { GpuRenderer } from 'browser/renderer/shared/gpu/GpuRenderer';
import type { IRenderService } from 'browser/services/Services';
import { Emitter, EventUtils } from 'common/Event';
import { Disposable, MutableDisposable } from 'common/Lifecycle';
import { WebgpuBackend } from './WebgpuBackend';
import { WebgpuContext } from './WebgpuContext';

/**
 * A shared WebGPU device + context for one webview. Create one session, then a
 * {@link WebgpuAddon} per terminal; all panes share the device, pipelines and
 * GPU atlas textures. Disposal destroys the device; createAddon() addons are
 * disposed independently without affecting the session.
 */
export class WebgpuSession extends Disposable implements IWebgpuSessionApi {
  private readonly _device: GPUDevice;
  private readonly _context: WebgpuContext;
  private readonly _onContextLoss = this._register(new Emitter<void>());
  public readonly onContextLoss = this._onContextLoss.event;
  private readonly _onError = this._register(new Emitter<Error>());
  public readonly onError = this._onError.event;

  private constructor(device: GPUDevice, context: WebgpuContext) {
    super();
    this._device = device;
    this._context = context;
    this._register(EventUtils.forward(context.onContextLoss, this._onContextLoss));
    this._register(EventUtils.forward(context.onError, this._onError));
  }

  public static async create(options: IWebgpuAddonOptions = {}): Promise<WebgpuSession> {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) {
      throw new Error('WebGPU is unavailable; use a secure context and a WebGPU-capable browser');
    }
    const adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference });
    if (!adapter) {
      throw new Error('No WebGPU adapter is available');
    }
    const device = await adapter.requestDevice();
    return new WebgpuSession(device, new WebgpuContext(device, gpu.getPreferredCanvasFormat()));
  }

  public createAddon(customGlyphs: boolean = true): WebgpuAddon {
    return WebgpuAddon.createForSession(this._context, this._device, customGlyphs);
  }

  public override dispose(): void {
    if (this._store.isDisposed) {
      return;
    }
    super.dispose();
    this._context.dispose();
    this._device.destroy();
  }
}

export class WebgpuAddon extends Disposable implements ITerminalAddon, IWebgpuApi {
  private _terminal: Terminal | undefined;
  private _renderer: GpuRenderer | undefined;
  private _lost = false;
  private readonly _openListener = this._register(new MutableDisposable());
  private readonly _onContextLoss = this._register(new Emitter<void>());
  public readonly onContextLoss = this._onContextLoss.event;
  private readonly _onError = this._register(new Emitter<Error>());
  public readonly onError = this._onError.event;
  private readonly _onChangeTextureAtlas = this._register(new Emitter<HTMLCanvasElement>());
  public readonly onChangeTextureAtlas = this._onChangeTextureAtlas.event;
  private readonly _onAddTextureAtlasCanvas = this._register(new Emitter<HTMLCanvasElement>());
  public readonly onAddTextureAtlasCanvas = this._onAddTextureAtlasCanvas.event;
  private readonly _onRemoveTextureAtlasCanvas = this._register(new Emitter<HTMLCanvasElement>());
  public readonly onRemoveTextureAtlasCanvas = this._onRemoveTextureAtlasCanvas.event;

  public static async create(options: IWebgpuAddonOptions = {}): Promise<WebgpuAddon> {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu) {
      throw new Error('WebGPU is unavailable; use a secure context and a WebGPU-capable browser');
    }
    const adapter = await gpu.requestAdapter({ powerPreference: options.powerPreference });
    if (!adapter) {
      throw new Error('No WebGPU adapter is available');
    }
    const device = await adapter.requestDevice();
    return new WebgpuAddon(new WebgpuContext(device, gpu.getPreferredCanvasFormat()), device, options.customGlyphs ?? true, true);
  }

  /** Internal: create an addon bound to a shared session context. */
  public static createForSession(context: WebgpuContext, device: GPUDevice, customGlyphs: boolean): WebgpuAddon {
    return new WebgpuAddon(context, device, customGlyphs, false);
  }

  private constructor(
    private readonly _context: WebgpuContext,
    private readonly _device: GPUDevice,
    private readonly _customGlyphs: boolean,
    private readonly _ownsDevice: boolean
  ) {
    super();
    this._register(this._context.onContextLoss(() => {
      if (!this._store.isDisposed) {
        this._lost = true;
        this._openListener.clear();
        this._restoreRenderer();
        this._onContextLoss.fire();
      }
    }));
    this._register(this._context.onError(error => {
      if (!this._store.isDisposed) {
        this._lost = true;
        this._openListener.clear();
        this._restoreRenderer();
        this._onError.fire(error);
      }
    }));
  }

  public activate(terminal: Terminal): void {
    if (this._store.isDisposed || this._lost) {
      throw new Error('Cannot activate a disposed or lost WebGPU addon');
    }
    if (this._terminal && this._terminal !== terminal || this._renderer) {
      throw new Error('A WebGPU addon can only be activated once');
    }
    this._terminal = terminal;
    const core = (terminal as any)._core as ITerminal;
    if (!terminal.element) {
      this._openListener.value = core.onWillOpen(() => {
        this._openListener.clear();
        this.activate(terminal);
      });
      return;
    }
    const unsafeCore = core as any;
    const renderer = new GpuRenderer(
      terminal, unsafeCore._characterJoinerService, unsafeCore._charSizeService,
      unsafeCore._coreBrowserService, core.coreService, unsafeCore._decorationService,
      unsafeCore._logService, core.optionsService, unsafeCore._themeService,
      this._customGlyphs, canvas => new WebgpuBackend(canvas, this._context)
    );
    this._renderer = this._register(renderer);
    this._register(renderer.onError(error => {
      this._lost = true;
      this._restoreRenderer();
      this._onError.fire(error);
    }));
    this._register(EventUtils.forward(renderer.onChangeTextureAtlas, this._onChangeTextureAtlas));
    this._register(EventUtils.forward(renderer.onAddTextureAtlasCanvas, this._onAddTextureAtlasCanvas));
    this._register(EventUtils.forward(renderer.onRemoveTextureAtlasCanvas, this._onRemoveTextureAtlasCanvas));
    const renderService: IRenderService = unsafeCore._renderService;
    renderService.setRenderer(renderer);
  }

  private _restoreRenderer(): void {
    // RenderService disposes replaced renderers. Never replace a newer addon on late loss/disposal.
    if (!this._renderer || this._renderer.isDisposed || !this._terminal) {
      return;
    }
    const core = (this._terminal as any)._core;
    if (!core._store.isDisposed) {
      const renderService: IRenderService = core._renderService;
      renderService.setRenderer(core._createRenderer());
      renderService.handleResize(this._terminal.cols, this._terminal.rows);
    }
  }

  public get textureAtlas(): HTMLCanvasElement | undefined { return this._renderer?.textureAtlas; }
  public clearTextureAtlas(): void { this._renderer?.clearTextureAtlas(); }

  public override dispose(): void {
    if (this._store.isDisposed) {
      return;
    }
    this._restoreRenderer();
    super.dispose();
    if (this._ownsDevice) {
      this._context.dispose();
      this._device.destroy();
    }
  }
}