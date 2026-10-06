/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// @ts-check

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Runs `xterm-benchmark` in a cross-platform way.
 *
 * @param {object} options
 * @param {string} options.repoRoot Repository root (used to locate the bin script).
 * @param {string[]} options.nodePaths Directories to add to `NODE_PATH`.
 * @param {string} options.benchmarkDir Directory containing compiled `*.benchmark.js` files.
 * @param {string} options.configPath Path to the `xterm-benchmark` config file.
 * @param {string} options.cwd Working directory for the benchmark process.
 * @param {string[]} [options.extraArgs] Extra args passed through to `xterm-benchmark`.
 */
function runBenchmark(options) {
  const env = { ...process.env };
  env.NODE_PATH = options.nodePaths.join(path.delimiter);

  const userArgs = options.extraArgs || [];

  // xterm-benchmark only runs the files passed to it, so default to all compiled
  // benchmark files. If the caller already passed a benchmark file (e.g. via
  // `-s`/`-t`) use that instead.
  let benchmarkFiles = [];
  if (!userArgs.some(arg => arg.includes('.benchmark.js'))) {
    benchmarkFiles = fs.existsSync(options.benchmarkDir)
      ? fs.readdirSync(options.benchmarkDir)
          .filter(name => name.endsWith('.benchmark.js'))
          .map(name => path.join(options.benchmarkDir, name))
      : [];
    if (benchmarkFiles.length === 0) {
      console.error(`No benchmark files found in ${options.benchmarkDir}. Run "pnpm run build" first.`);
      process.exit(1);
    }
  }

  const bin = path.resolve(options.repoRoot, 'node_modules/.bin/xterm-benchmark' + (process.platform === 'win32' ? '.cmd' : ''));
  const args = [
    '-r', '5',
    '-c', options.configPath,
    ...userArgs,
    ...benchmarkFiles
  ];

  const run = cp.spawnSync(bin, args, {
    cwd: options.cwd,
    env,
    shell: true,
    stdio: 'inherit'
  });

  if (run.error) {
    console.error(run.error);
  }
  process.exit(run.status ?? -1);
}

module.exports = { runBenchmark };
