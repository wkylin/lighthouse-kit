import assert from 'node:assert/strict'
import test from 'node:test'
import { captureAllocationSampling, captureAllocationTimeline, captureDetachedElements, captureHeapSnapshot, collectMemoryMetrics } from '../src/memory.mjs'

function mockPage(responses) {
  const calls = []
  const client = {
    async send(method, params) {
      calls.push({ method, params })
      if (!(method in responses)) throw new Error(`Unsupported CDP command: ${method}`)
      const value = responses[method]
      if (value instanceof Error) throw value
      return typeof value === 'function' ? value(params) : value
    },
    async detach() { calls.push({ method: 'detach' }) },
  }
  return { page: { target: () => ({ createCDPSession: async () => client }) }, calls }
}

test('heap collection uses actual CDP heap bytes and tolerates an unavailable heap limit', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { page, calls } = mockPage({
    'HeapProfiler.enable': {},
    'HeapProfiler.collectGarbage': {},
    'Runtime.getHeapUsage': { usedSize: 12_345, totalSize: 65_536 },
    'Runtime.evaluate': new Error('Unavailable'),
    'HeapProfiler.disable': {},
  })
  assert.deepEqual(await captureHeapSnapshot(page), {
    usedJsHeapSize: 12_345, totalJsHeapSize: 65_536, jsHeapSizeLimit: null,
  })
  assert.equal(calls.at(-1).method, 'detach')
})

test('timeline observes actual heap samples and keeps a transient peak', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const sizes = [10, 25, 15]
  let callbackCount = 0
  let finishInteraction
  const interaction = new Promise(resolve => { finishInteraction = resolve })
  const { page, calls } = mockPage({
    'Runtime.getHeapUsage': () => {
      const usedSize = sizes.length ? sizes.shift() : 15
      if (!sizes.length) finishInteraction()
      return { usedSize }
    },
  })
  const result = await captureAllocationTimeline(page, async () => { callbackCount++; await interaction }, { durationMs: 20, samplingIntervalMs: 5 })
  assert.ok(result)
  assert.equal(result.baselineMemory, 10)
  assert.equal(result.peakMemory, 25)
  assert.equal(result.growthRate, 15)
  assert.ok(result.duration >= 20)
  assert.ok(result.growthRatePerSecond > 0 && result.growthRatePerSecond <= 750)
  assert.ok(result.allocations.length >= 3)
  assert.equal(result.allocations.at(-1).memory, 15)
  assert.equal(callbackCount, 1)
  assert.equal(calls.at(-1).method, 'detach')
})

test('allocation sampling counts the whole profile and resolves real function call frames', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { page, calls } = mockPage({
    'HeapProfiler.enable': {},
    'HeapProfiler.startSampling': {},
    'HeapProfiler.stopSampling': { profile: {
      head: { id: 1, selfSize: 0, callFrame: {}, children: [
        { id: 2, selfSize: 2400, children: [], callFrame: { functionName: 'allocate', url: 'https://example.com/app.js', lineNumber: 4, columnNumber: 2 } },
      ] },
      samples: Array.from({ length: 24 }, (_, i) => ({ nodeId: 2, size: 100, ordinal: i + 1 })),
    } },
    'HeapProfiler.disable': {},
  })
  const result = await captureAllocationSampling(page, null, { durationMs: 20 })
  assert.ok(result)
  assert.equal(result.sampleCount, 24)
  assert.equal(result.totalAllocatedBytes, 2400)
  assert.equal(result.topFunctions.length, 1)
  assert.deepEqual(result.topFunctions[0], { nodeId: 2, functionName: 'allocate', url: 'https://example.com/app.js', lineNumber: 4, columnNumber: 2, size: 2400, sampleCount: 24 })
  assert.ok(result.duration >= 20)
  assert.ok(result.allocationRate > 0)
  assert.ok(result.allocationBytesPerSecond > 0)
  assert.equal(result.overhead, undefined)
  const params = calls.find(c => c.method === 'HeapProfiler.startSampling').params
  assert.equal(params.includeObjectsCollectedByMajorGC, true)
  assert.equal(params.includeObjectsCollectedByMinorGC, true)
  assert.equal(calls.at(-1).method, 'detach')
})

test('detached nodes come from CDP after GC and unavailable byte size stays null', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { page, calls } = mockPage({
    'HeapProfiler.enable': {}, 'HeapProfiler.collectGarbage': {}, 'HeapProfiler.disable': {},
    'DOM.enable': {}, 'DOM.disable': {},
    'DOM.getDetachedDomNodes': { detachedNodes: [
      { treeNode: { nodeId: 1, backendNodeId: 3, nodeName: 'DIV', children: [{ nodeId: 2, backendNodeId: 4, nodeName: 'SPAN' }] }, retainedNodeIds: [3] },
      { treeNode: { nodeId: 3, backendNodeId: 5, nodeName: 'P' }, retainedNodeIds: [5] },
    ] },
  })
  const result = await captureDetachedElements(page)
  assert.equal(result.detachedCount, 3)
  assert.equal(result.detachedMemory, null)
  assert.equal(result.topDetached.length, 2)
  assert.equal(result.topDetached[0].nodeName, 'DIV')
  assert.ok(calls.findIndex(c => c.method === 'HeapProfiler.collectGarbage') < calls.findIndex(c => c.method === 'DOM.getDetachedDomNodes'))
  assert.equal(calls.at(-1).method, 'detach')
})

test('unsupported detached collection returns null and releases its session', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { page, calls } = mockPage({
    'HeapProfiler.enable': {}, 'HeapProfiler.collectGarbage': {}, 'HeapProfiler.disable': {},
    'DOM.enable': {}, 'DOM.disable': {},
    'DOM.getDetachedDomNodes': new Error('Method not found'),
  })
  assert.equal(await captureDetachedElements(page), null)
  assert.equal(calls.at(-1).method, 'detach')
})

test('sampling failure stops the profiler before releasing its session', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { page, calls } = mockPage({
    'HeapProfiler.enable': {}, 'HeapProfiler.startSampling': {},
    'HeapProfiler.stopSampling': {}, 'HeapProfiler.disable': {},
  })
  assert.equal(await captureAllocationSampling(page, async () => { throw new Error('Interaction failed') }, { durationMs: 0 }), null)
  assert.ok(calls.some(c => c.method === 'HeapProfiler.stopSampling'))
  assert.equal(calls.at(-1).method, 'detach')
})

test('complete collection keeps working sections when one CDP capability fails', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const { page } = mockPage({
    'HeapProfiler.enable': {}, 'HeapProfiler.collectGarbage': {}, 'HeapProfiler.disable': {},
    'Runtime.getHeapUsage': { usedSize: 100, totalSize: 200 },
    'Runtime.evaluate': { result: { value: 500 } },
    'HeapProfiler.startSampling': {},
    'HeapProfiler.stopSampling': { profile: { head: { id: 1, callFrame: {}, children: [] }, samples: [] } },
    'DOM.enable': {}, 'DOM.disable': {},
    'DOM.getDetachedDomNodes': new Error('Method not found'),
  })
  const result = await collectMemoryMetrics(page, { durationMs: 5, samplingIntervalMs: 2 })
  assert.equal(result.heapSnapshot.usedJsHeapSize, 100)
  assert.equal(result.heapSnapshot.jsHeapSizeLimit, 500)
  assert.equal(result.allocationTimeline.growthRate, 0)
  assert.equal(result.allocationSampling.sampleCount, 0)
  assert.equal(result.detachedElements, null)
  assert.ok(!Number.isNaN(Date.parse(result.collectedAt)))
})

test('exhausted collection budget does not open CDP sessions', async () => {
  const { page, calls } = mockPage({})
  const result = await collectMemoryMetrics(page, { timeoutMs: 0 })
  assert.equal(result.heapSnapshot, null)
  assert.equal(result.allocationTimeline, null)
  assert.equal(result.allocationSampling, null)
  assert.equal(result.detachedElements, null)
  assert.deepEqual(calls, [])
})
