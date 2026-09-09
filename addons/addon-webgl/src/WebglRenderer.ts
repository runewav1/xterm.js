/**
 * Copyright (c) 2018 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { Terminal } from '@xterm/xterm';
import { addDisposableListener } from 'browser/Dom';
import { GpuRenderer } from 'browser/renderer/shared/gpu/GpuRenderer';
import { IGpuBackend, IGlyphRenderer, IRectangleRenderer } from 'browser/renderer/shared/gpu/Types';
import { IRenderDimensions } from 'browser/renderer/shared/Types';
import { throwIfFalsy } from 'browser/renderer/shared/RendererUtils';
import { ICharacterJoinerService, ICharSizeService, ICoreBrowserService, IThemeService } from 'browser/services/Services';
import { Emitter } from 'common/Event';
import { Disposable, toDisposable } from 'common/Lifecycle';
import { ICoreService, IDecorationService, ILogService, IOptionsService } from 'common/services/Services';
import { GlyphRenderer } from './GlyphRenderer';
import { RectangleRenderer } from './RectangleRenderer';
import { IWebGL2RenderingContext } from './Types';

export class WebglRenderer extends GpuRenderer {
  constructor(
    terminal: Terminal,
    characterJoinerService: ICharacterJoinerService,
    charSizeService: ICharSizeService,
    coreBrowserService: ICoreBrowserService,
    coreService: ICoreService,
    decorationService: IDecorationService,
    logService: ILogService,
    optionsService: IOptionsService,
    themeService: IThemeService,
    customGlyphs: boolean = true,
    preserveDrawingBuffer?: boolean
  ) {
    super(terminal, characterJoinerService, charSizeService, coreBrowserService, coreService, decorationService, logService, optionsService, themeService, customGlyphs, canvas => new WebglBackend(canvas, logService, preserveDrawingBuffer));
  }
}

class WebglBackend extends Disposable implements IGpuBackend {
  private readonly _gl: IWebGL2RenderingContext;
  private _contextRestorationTimeout: ReturnType<typeof setTimeout> | undefined;
  public readonly maxTextureSize: number;
  public readonly maxAtlasPages: number;
  private readonly _onContextLoss = this._register(new Emitter<void>());
  public readonly onContextLoss = this._onContextLoss.event;
  private readonly _onContextRestored = this._register(new Emitter<void>());
  public readonly onContextRestored = this._onContextRestored.event;

  constructor(canvas: HTMLCanvasElement, logService: ILogService, preserveDrawingBuffer?: boolean) {
    super();
    this._gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer }) as IWebGL2RenderingContext;
    if (!this._gl) {
      throw new Error('WebGL2 not supported ' + this._gl);
    }
    this.maxTextureSize = throwIfFalsy(this._gl.getParameter(this._gl.MAX_TEXTURE_SIZE) as number | null);
    this.maxAtlasPages = Math.min(32, throwIfFalsy(this._gl.getParameter(this._gl.MAX_TEXTURE_IMAGE_UNITS) as number | null));
    this._register(addDisposableListener(canvas, 'webglcontextlost', e => {
      logService.debug('webglcontextlost event received');
      e.preventDefault();
      clearTimeout(this._contextRestorationTimeout);
      this._contextRestorationTimeout = setTimeout(() => {
        this._contextRestorationTimeout = undefined;
        logService.warn('webgl context not restored; firing onContextLoss');
        this._onContextLoss.fire();
      }, 3000);
    }));
    this._register(addDisposableListener(canvas, 'webglcontextrestored', () => {
      logService.warn('webglcontextrestored event received');
      clearTimeout(this._contextRestorationTimeout);
      this._contextRestorationTimeout = undefined;
      this._onContextRestored.fire();
    }));
    this._register(toDisposable(() => clearTimeout(this._contextRestorationTimeout)));
  }

  public createRenderers(terminal: Terminal, dimensions: IRenderDimensions, optionsService: IOptionsService, themeService: IThemeService, logService: ILogService): { glyphRenderer: IGlyphRenderer, rectangleRenderer: IRectangleRenderer } {
    const rectangleRenderer = new RectangleRenderer(terminal, this._gl, dimensions, themeService, logService);
    try {
      const glyphRenderer = new GlyphRenderer(terminal, this._gl, dimensions, optionsService, logService);
      return { glyphRenderer, rectangleRenderer };
    } catch (e) {
      rectangleRenderer.dispose();
      throw e;
    }
  }

  public beginRender(_dimensions: IRenderDimensions): void {}
  public endRender(): void {}
}
