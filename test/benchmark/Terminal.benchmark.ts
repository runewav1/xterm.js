/**
 * Copyright (c) 2019 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { perfContext, before, ThroughputRuntimeCase } from 'xterm-benchmark';

import * as fs from 'fs';
import * as path from 'path';

import { CoreBrowserTerminal } from 'browser/CoreBrowserTerminal';

const TARGET_SIZE = 2_000_000;

/**
 * Builds a realistic, ANSI colored recursive directory listing to feed into the
 * terminal. This replaces the previous `ls -lR /usr/lib` dependency, which does
 * not exist on Windows (the target platform of this build).
 */
function buildListing(): string {
  const root = path.resolve(__dirname, '../../src');
  const lines: string[] = [];
  const walk = (dir: string): void => {
    lines.push(`\x1b[1;34m${path.relative(root, dir) || '.'}\x1b[0m:`);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, entry.name)).size;
      } catch {
        // ignore unreadable entries
      }
      const isDir = entry.isDirectory();
      const mode = isDir ? 'drwxr-xr-x' : '-rw-r--r--';
      const color = isDir ? '\x1b[1;34m' : entry.name.endsWith('.ts') ? '\x1b[32m' : '\x1b[0m';
      lines.push(`${mode} 1 user group ${String(size).padStart(8)} Jan  1 00:00 ${color}${entry.name}\x1b[0m`);
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  if (lines.length === 0) {
    throw new Error(`Could not build benchmark content from ${root}`);
  }
  return lines.join('\r\n') + '\r\n';
}

perfContext('Terminal: recursive directory listing', () => {
  let content = '';
  let contentUtf8: Uint8Array;

  before(() => {
    const listing = buildListing();
    while (content.length < TARGET_SIZE) {
      content += listing;
    }
    contentUtf8 = Buffer.from(content, 'utf8');
  });

  perfContext('write/string', () => {
    let terminal: CoreBrowserTerminal;
    before(() => {
      terminal = new CoreBrowserTerminal({ cols: 80, rows: 25, scrollback: 1000 });
    });
    new ThroughputRuntimeCase('', async () => {
      await new Promise<void>(res => terminal.write(content, res));
      return { payloadSize: contentUtf8.length };
    }, { fork: false }).showAverageThroughput();
  });

  perfContext('write/utf8', () => {
    let terminal: CoreBrowserTerminal;
    before(() => {
      terminal = new CoreBrowserTerminal({ cols: 80, rows: 25, scrollback: 1000 });
    });
    new ThroughputRuntimeCase('', async () => {
      await new Promise<void>(res => terminal.write(contentUtf8, res));
      return { payloadSize: contentUtf8.length };
    }, { fork: false }).showAverageThroughput();
  });
});
