---
name: benchmark
description: Run and author benchmark tests in xterm.js. Use when editing benchmark files, working in `*.benchmark.ts`, or when asked how to run the full benchmark suite, a single benchmark file, or a single benchmark case.
---

# Benchmark Run Instructions

## Running Benchmarks

- Full suite: `pnpm run benchmark`
- Single benchmark file:
  - Tree: `pnpm run benchmark -t out-test/benchmark/Event.benchmark.js`
  - Run file: `pnpm run benchmark -s "out-test/benchmark/Event.benchmark.js" out-test/benchmark/Event.benchmark.js`
- Single context/case:
  - Use `-t` to get the path, then:
  - `pnpm run benchmark -s "<path>" out-test/benchmark/Event.benchmark.js`

## Benchmark Case Selection

When writing benchmark instructions:

- Use `RuntimeCase` to measure pure runtime in ms.
- Use `ThroughputRuntimeCase` when measuring throughput in MB/s.

## Notes

- Benchmarks run from built JS in `out-test/benchmark/*.benchmark.js`.
- Keep `NODE_PATH=./out` (handled by the pnpm script).
