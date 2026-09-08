/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { TextureAtlas } from './TextureAtlas';
import { ITerminalOptions, Terminal } from '@xterm/xterm';
import { ITerminal, ReadonlyColorSet } from '../../../Types';
import { ICharAtlasConfig, ITextureAtlas } from './Types';
import { generateConfig, configEquals } from './CharAtlasUtils';
import type { ILogService } from '../../../../common/services/Services';

interface ITextureAtlasCacheEntry {
  atlas: TextureAtlas;
  config: ICharAtlasConfig;
  ownedBy: object[];
}

const charAtlasCache: ITextureAtlasCacheEntry[] = [];

/**
 * Acquires a char atlas, either generating a new one or returning an existing
 * one that is in use by another terminal.
 */
export function acquireTextureAtlas(
  terminal: Terminal,
  owner: object,
  options: Required<ITerminalOptions>,
  colors: ReadonlyColorSet,
  deviceCellWidth: number,
  deviceCellHeight: number,
  deviceCharWidth: number,
  deviceCharHeight: number,
  devicePixelRatio: number,
  maxTextureSize: number,
  maxAtlasPages: number,
  customGlyphs: boolean = true
): ITextureAtlas {
  const newConfig = generateConfig(deviceCellWidth, deviceCellHeight, deviceCharWidth, deviceCharHeight, options, colors, devicePixelRatio, maxTextureSize, maxAtlasPages, customGlyphs);

  // Ownership is renderer-scoped: a replacement is constructed before the old renderer is disposed.
  for (let i = 0; i < charAtlasCache.length; i++) {
    const entry = charAtlasCache[i];
    const ownedByIndex = entry.ownedBy.indexOf(owner);
    if (ownedByIndex >= 0) {
      if (configEquals(entry.config, newConfig)) {
        return entry.atlas;
      }
      // The configs differ, release this owner from the entry
      entry.atlas.detachFromDom();
      if (entry.ownedBy.length === 1) {
        entry.atlas.dispose();
        charAtlasCache.splice(i, 1);
      } else {
        entry.ownedBy.splice(ownedByIndex, 1);
      }
      break;
    }
  }

  // Try match a char atlas from the cache
  for (let i = 0; i < charAtlasCache.length; i++) {
    const entry = charAtlasCache[i];
    if (configEquals(entry.config, newConfig)) {
      entry.ownedBy.push(owner);
      return entry.atlas;
    }
  }

  const core: ITerminal = (terminal as any)._core;
  const logService = (core as any)._logService as ILogService;
  const newEntry: ITextureAtlasCacheEntry = {
    atlas: new TextureAtlas(terminal.element!.ownerDocument, newConfig, core.unicodeService, logService),
    config: newConfig,
    ownedBy: [owner]
  };
  charAtlasCache.push(newEntry);
  return newEntry.atlas;
}

/**
 * Releases an owner's atlas, disposing it when the last renderer releases it.
 */
export function releaseTextureAtlas(owner: object): void {
  for (let i = 0; i < charAtlasCache.length; i++) {
    const index = charAtlasCache[i].ownedBy.indexOf(owner);
    if (index !== -1) {
      charAtlasCache[i].atlas.detachFromDom();
      if (charAtlasCache[i].ownedBy.length === 1) {
        // Remove the cache entry if it's the only terminal
        charAtlasCache[i].atlas.dispose();
        charAtlasCache.splice(i, 1);
      } else {
        // Remove the reference from the cache entry
        charAtlasCache[i].ownedBy.splice(index, 1);
      }
      break;
    }
  }
}
