import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregateMemory, memoryForSummary } from '../src/memory-summary.mjs'
import { MEMORY_THRESHOLDS, memoryFindingsForPage } from '../src/analyze/memory.mjs'

const MiB = 1024 * 1024
const run = (memory, ok = true) => ({ ok, memory })
const heap = (usedJsHeapSize, jsHeapSizeLimit = null) => ({ heapSnapshot: { usedJsHeapSize, jsHeapSizeLimit } })
const ids = (memory) => memoryFindingsForPage(memory).map((f) => f.id)
const summary = (memory) => aggregateMemory([run(memory)])

test('memory medians include all successful observations, even when representative memory is missing', () => {
  const raw = [run(heap(30)), run(null), run(heap(10)), run(heap(20)), run(heap(999), false)]
  const before = structuredClone(raw)
  assert.equal(aggregateMemory(raw).heapSnapshot.usedJsHeapSize, 20)
  assert.equal(aggregateMemory(raw).runs, 3)
  assert.equal(aggregateMemory([run(heap(10)), run(heap(20))]).heapSnapshot.usedJsHeapSize, 15)
  assert.deepEqual(raw, before, 'aggregation must preserve raw run evidence')
})

test('missing, non-finite, negative and failed memory values stay unknown; valid zeros survive', () => {
  assert.equal(aggregateMemory([]), null)
  assert.equal(aggregateMemory([run(null), run({}), run(heap(50), false)]), null)
  assert.equal(aggregateMemory([run(heap(NaN)), run(heap(Infinity)), run(heap(-2))]), null)
  const result = aggregateMemory([run(heap(0)), run(heap('100')), run({ detachedElements: { detachedCount: 0 } })])
  assert.equal(result.heapSnapshot.usedJsHeapSize, 0)
  assert.equal(result.heapSnapshot.jsHeapSizeLimit, null)
  assert.equal(result.detachedElements.detachedCount, 0)
  assert.equal(result.detachedElements.detachedMemory, null)
  assert.equal(result.allocationTimeline, null)
})

test('heap ratios and rates are calculated per run before taking their median', () => {
  const result = aggregateMemory([
    run({ ...heap(10, 20), allocationTimeline: { baselineMemory: 0, peakMemory: 10, duration: 1000 },
      allocationSampling: { duration: 1000, sampleCount: 100, totalAllocatedBytes: 1000 } }),
    run({ ...heap(80, 100), allocationTimeline: { baselineMemory: 0, peakMemory: 90, duration: 3000 },
      allocationSampling: { duration: 3000, sampleCount: 30, totalAllocatedBytes: 300 } }),
  ])
  assert.equal(result.heapSnapshot.heapUsageRatio, 0.65)
  assert.equal(result.allocationTimeline.growthRatePerSecond, 20)
  assert.equal(result.allocationSampling.allocationRate, 55)
  assert.equal(result.allocationSampling.allocationBytesPerSecond, 550)
})

test('legacy timeline timestamps provide duration, but a top-20 hotspot list cannot provide allocation counts', () => {
  const result = summary({ allocationTimeline: { baselineMemory: 100, peakMemory: 200,
    allocations: [{ timestamp: 0, memory: 100 }, { timestamp: 2000, memory: 200 }] },
  allocationSampling: { duration: 2000, topFunctions: Array.from({ length: 20 }, () => ({ size: 100 })) } })
  assert.equal(result.allocationTimeline.growthRatePerSecond, 50)
  assert.equal(result.allocationSampling.sampleCount, null)
  assert.equal(result.allocationSampling.allocationRate, null)
})

test('zero, missing and short observation durations do not yield rates or rate findings', () => {
  for (const duration of [0, 10, 999, null, NaN, -1]) {
    const result = summary({ allocationTimeline: { baselineMemory: 0, peakMemory: 30 * MiB, duration },
      allocationSampling: { duration, sampleCount: 10000, totalAllocatedBytes: MiB } })
    assert.equal(result.allocationTimeline.growthRatePerSecond, null)
    assert.equal(result.allocationSampling.allocationRate, null)
    assert.deepEqual(ids(result), [])
  }
})

test('summary lookup prefers all runs and supports aggregate-only and representative-only historical summaries', () => {
  const raw = heap(10)
  const aggregate = summary(heap(50))
  assert.equal(memoryForSummary({ ok: true, runs: [run(heap(20)), run(heap(40))], memory: raw }).heapSnapshot.usedJsHeapSize, 30)
  assert.equal(memoryForSummary({ ok: true, runs: [run(null)], memory: raw }), null)
  assert.deepEqual(memoryForSummary({ ok: true, median: { memory: aggregate } }), aggregate)
  assert.equal(memoryForSummary({ ok: true, memory: raw }).heapSnapshot.usedJsHeapSize, 10)
  assert.equal(memoryForSummary({ ok: false, memory: raw }), null)
  assert.equal(memoryForSummary({ ok: true }), null)
})

test('high heap triggers at the byte or ratio threshold, with zero Lighthouse savings', () => {
  assert.deepEqual(ids(summary(heap(MEMORY_THRESHOLDS.heapBytes - 1))), [])
  for (const memory of [heap(100 * MiB), heap(80, 100)]) {
    const [finding] = memoryFindingsForPage(summary(memory))
    assert.equal(finding.id, 'memory-high-heap')
    assert.equal(finding.group, 'memory')
    assert.equal(finding.score, null)
    assert.equal(finding.impact, 0)
    assert.ok(Object.values(finding.savings).every((n) => n === 0))
    assert.ok(finding.evidence.length)
  }
  assert.deepEqual(ids(summary(heap(1, 0))), [])
})

test('detached DOM count or bytes trigger suspicion with explicit confirmation advice', () => {
  assert.deepEqual(ids(summary({ detachedElements: { detachedCount: 9, detachedMemory: MiB - 1 } })), [])
  for (const detachedElements of [{ detachedCount: 10 }, { detachedMemory: MiB }]) {
    const [finding] = memoryFindingsForPage(summary({ detachedElements }))
    assert.equal(finding.id, 'memory-detached-elements')
    assert.match(finding.title, /疑似/)
    assert.match(finding.advice, /不能证明泄漏/)
  }
})

test('rapid growth needs meaningful absolute growth and rate, with an observation window', () => {
  const memory = (peakMemory, duration) => summary({ allocationTimeline: { baselineMemory: 0, peakMemory, duration } })
  assert.deepEqual(ids(memory(10 * MiB, 2000)), ['memory-rapid-growth'])
  assert.deepEqual(ids(memory(10 * MiB - 1, 1000)), [])
  assert.deepEqual(ids(memory(10 * MiB, 2001)), [])
})

test('allocation frequency uses total sample count, not hotspots or fabricated overhead', () => {
  const memory = (sampleCount) => summary({ allocationSampling: { sampleCount, duration: 2000,
    samplingInterval: 32768, topFunctions: [], overhead: 5000 } })
  assert.deepEqual(ids(memory(199)), [])
  const [finding] = memoryFindingsForPage(memory(200))
  assert.equal(finding.id, 'memory-high-allocation-rate')
  assert.match(finding.evidence[0].label, /100\.0 样本\/s/)
  assert.match(finding.evidence[0].label, /32 KiB/)
})

test('unknown or invalid observations produce no memory findings', () => {
  for (const memory of [null, {}, { heapSnapshot: { usedJsHeapSize: Infinity, heapUsageRatio: NaN },
    detachedElements: { detachedCount: -5, detachedMemory: '99999999' },
    allocationTimeline: { duration: 1000, growthRate: Infinity, growthRatePerSecond: Infinity },
    allocationSampling: { duration: 1000, allocationRate: Infinity } }]) assert.deepEqual(ids(memory), [])
})

test('aggregate-only memory validates cached fields without recalculating ratios or rates', () => {
  assert.equal(memoryForSummary({ ok: true, memory: { runs: 3, heapSnapshot: { usedJsHeapSize: -10 } } }), null)
  assert.equal(memoryForSummary({ ok: true, memory: { runs: Infinity, heapSnapshot: { usedJsHeapSize: 10 } } }), null)
  const stored = { runs: 2, heapSnapshot: { usedJsHeapSize: 45, jsHeapSizeLimit: 60, heapUsageRatio: 0.65 },
    allocationSampling: { duration: 2000, sampleCount: 65, allocationRate: 55, totalAllocatedBytes: -5 } }
  const memory = memoryForSummary({ ok: true, median: { memory: stored } })
  assert.equal(memory.heapSnapshot.heapUsageRatio, 0.65)
  assert.equal(memory.allocationSampling.allocationRate, 55)
  assert.equal(memory.allocationSampling.totalAllocatedBytes, null)
})

test('short windows do not suppress valid long-window rate findings from other runs', () => {
  const memory = aggregateMemory([10, 10, 1000].map((duration) => run({
    allocationTimeline: { duration, baselineMemory: 0, peakMemory: 20 * MiB },
    allocationSampling: { duration, sampleCount: 500, samplingInterval: 32768 },
  })))
  assert.deepEqual(ids(memory), ['memory-rapid-growth', 'memory-high-allocation-rate'])
})
