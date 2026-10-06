/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// @ts-check

const path = require('path');
const { runBenchmark } = require('../../../bin/benchmark_lib');

const addonRoot = path.resolve(__dirname, '..');

runBenchmark({
  repoRoot: path.resolve(__dirname, '../../..'),
  nodePaths: [
    path.resolve(__dirname, '../../../out'),
    path.resolve(addonRoot, 'out-benchmark/src')
  ],
  benchmarkDir: path.resolve(addonRoot, 'out-benchmark/benchmark'),
  configPath: path.resolve(__dirname, 'benchmark.json'),
  cwd: addonRoot,
  extraArgs: process.argv.slice(2)
});
