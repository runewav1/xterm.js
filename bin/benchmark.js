/**
 * Copyright (c) 2026 The xterm.js authors. All rights reserved.
 * @license MIT
 */

// @ts-check

const path = require('path');
const { runBenchmark } = require('./benchmark_lib');

runBenchmark({
  repoRoot: path.resolve(__dirname, '..'),
  nodePaths: [path.resolve(__dirname, '../out')],
  benchmarkDir: path.resolve(__dirname, '../out-test/benchmark'),
  configPath: path.resolve(__dirname, '../test/benchmark/benchmark.json'),
  cwd: path.resolve(__dirname, '..'),
  extraArgs: process.argv.slice(2)
});
