/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

declare module '@partty/addon-webgpu' {
  import { IEvent, ITerminalAddon, Terminal } from '@xterm/xterm';

  export interface IWebgpuAddonOptions {
    /** Prefer low power or high performance hardware. The browser may ignore this hint. */
    powerPreference?: 'low-power' | 'high-performance';
    /** Whether to rasterize terminal-specific glyphs. Defaults to true. */
    customGlyphs?: boolean;
  }

  /** Experimental, fork-specific renderer. Requires WebGPU in a secure context. */
  export class WebgpuAddon implements ITerminalAddon {
    private constructor();
    /** Acquire a device before loading the addon. Failure leaves the current renderer untouched. */
    static create(options?: IWebgpuAddonOptions): Promise<WebgpuAddon>;
    /** Fires after device loss. The active renderer is restored to DOM automatically. */
    readonly onContextLoss: IEvent<void>;
    /** Fires on asynchronous GPU validation errors, after falling back to DOM. */
    readonly onError: IEvent<Error>;
    readonly onChangeTextureAtlas: IEvent<HTMLCanvasElement>;
    readonly onAddTextureAtlasCanvas: IEvent<HTMLCanvasElement>;
    readonly onRemoveTextureAtlasCanvas: IEvent<HTMLCanvasElement>;
    readonly textureAtlas: HTMLCanvasElement | undefined;
    activate(terminal: Terminal): void;
    clearTextureAtlas(): void;
    /** Release the owned device. If still active, restore the default DOM renderer. */
    dispose(): void;
  }

  /**
   * A shared WebGPU device + context for one webview. Create one session, then
   * a {@link WebgpuAddon} per terminal; all panes share the device, pipelines
   * and GPU atlas textures. Disposal destroys the device.
   */
  export class WebgpuSession {
    private constructor();
    static create(options?: IWebgpuAddonOptions): Promise<WebgpuSession>;
    /** Fires after device loss; every pane addon also restores DOM. */
    readonly onContextLoss: IEvent<void>;
    /** Fires on asynchronous GPU validation errors, after all panes fell back to DOM. */
    readonly onError: IEvent<Error>;
    /** Create an addon for one terminal. Disposing the addon does not affect the session. */
    createAddon(customGlyphs?: boolean): WebgpuAddon;
    /** Destroy the device and release shared resources. Idempotent. */
    dispose(): void;
  }
}
