/**
 * Chrome DevTools Protocol (CDP) 内存收集模块
 * 负责通过 Puppeteer 页面实例收集 4 种内存指标
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 获取 GC 后的堆统计，不生成完整堆快照。
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('./types.mjs').HeapSnapshot|null>}
 */
export async function captureHeapSnapshot(page) {
  let client
  try {
    client = await page.target().createCDPSession()
    await client.send('HeapProfiler.enable')

    await client.send('HeapProfiler.collectGarbage')
    const heap = await client.send('Runtime.getHeapUsage')
    // CDP 堆统计不提供堆上限，浏览器不提供此值时保留 null。
    const limit = await client.send('Runtime.evaluate', {
      expression: 'globalThis.performance?.memory?.jsHeapSizeLimit ?? null',
      returnByValue: true,
    }).catch(() => null)
    const jsHeapSizeLimit = limit?.result?.value

    return {
      totalJsHeapSize: heap.totalSize,
      usedJsHeapSize: heap.usedSize,
      jsHeapSizeLimit: Number.isFinite(jsHeapSizeLimit) && jsHeapSizeLimit > 0 ? jsHeapSizeLimit : null,
    }
  } catch (error) {
    console.warn('堆快照收集失败:', error.message)
    return null
  } finally {
    if (client) {
      await client.send('HeapProfiler.disable').catch(() => {})
      await client.detach().catch(() => {})
    }
  }
}

/**
 * 在观察窗口内定期读取堆大小；growthRate 保留旧字段的 bytes 含义。
 * @param {import('puppeteer-core').Page} page
 * @param {Function|null} callback
 * @param {{durationMs?:number, samplingIntervalMs?:number}} options
 * @returns {Promise<import('./types.mjs').AllocationTimeline|null>}
 */
export async function captureAllocationTimeline(page, callback, { durationMs = 1000, samplingIntervalMs = 250 } = {}) {
  let client
  try {
    client = await page.target().createCDPSession()
    const baselineMemory = (await client.send('Runtime.getHeapUsage')).usedSize
    const allocations = [{ timestamp: 0, memory: baselineMemory }]
    let peakMemory = baselineMemory
    const duration = await observeWindow(callback, durationMs, samplingIntervalMs, async (timestamp) => {
      const memory = (await client.send('Runtime.getHeapUsage')).usedSize
      peakMemory = Math.max(peakMemory, memory)
      allocations.push({ timestamp, memory })
    })
    const growthRate = peakMemory - baselineMemory
    return {
      samplingInterval: samplingIntervalMs,
      baselineMemory,
      peakMemory,
      growthRate,
      duration,
      growthRatePerSecond: duration > 0 ? growthRate * 1000 / duration : null,
      allocations,
    }
  } catch (error) {
    console.warn('时间轴分配收集失败:', error.message)
    return null
  } finally {
    if (client) await client.detach().catch(() => {})
  }
}

// 持续观察至少指定时长，并覆盖回调执行期。回调异常在停止观察后上抛。
async function observeWindow(callback, durationMs, samplingIntervalMs, sample) {
  const startTime = Date.now()
  let pending = Boolean(callback)
  let callbackError
  const interaction = Promise.resolve().then(() => callback?.()).then(
    () => { pending = false },
    (error) => { pending = false; callbackError = error },
  )
  while (pending || Date.now() - startTime < durationMs) {
    const remaining = durationMs - (Date.now() - startTime)
    await sleep(Math.max(1, Math.min(samplingIntervalMs, remaining > 0 ? remaining : samplingIntervalMs)))
    if (sample) await sample(Date.now() - startTime)
  }
  await interaction
  if (callbackError) throw callbackError
  return Date.now() - startTime
}

/**
 * 获取函数级分配采样，速率为采样代理量，不等于真实对象分配次数。
 * @param {import('puppeteer-core').Page} page
 * @param {Function|null} callback
 * @param {{durationMs?:number}} options
 * @returns {Promise<import('./types.mjs').AllocationSampling|null>}
 */
export async function captureAllocationSampling(page, callback, { durationMs = 1000 } = {}) {
  let client
  let sampling = false
  try {
    client = await page.target().createCDPSession()
    await client.send('HeapProfiler.enable')
    await client.send('HeapProfiler.startSampling', {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    })
    sampling = true
    const duration = await observeWindow(callback, durationMs, 250)
    const { profile } = await client.send('HeapProfiler.stopSampling')
    sampling = false
    const functions = new Map()
    const visit = (node) => {
      if (!node) return
      functions.set(node.id, { nodeId: node.id, ...node.callFrame, size: 0, sampleCount: 0 })
      for (const child of node.children ?? []) visit(child)
    }
    visit(profile.head)
    let totalAllocatedBytes = 0
    const samples = profile.samples ?? []
    for (const sample of samples) {
      totalAllocatedBytes += sample.size
      const fn = functions.get(sample.nodeId)
      if (fn) { fn.size += sample.size; fn.sampleCount++ }
    }
    // 样本保留全部计数；热点仅为按分配字节数排序的前 20 个函数。
    const topFunctions = [...functions.values()].filter(fn => fn.sampleCount > 0).sort((a, b) => b.size - a.size || a.nodeId - b.nodeId).slice(0, 20)
    return {
      samplingInterval: 32768,
      duration,
      sampleCount: samples.length,
      totalAllocatedBytes,
      allocationRate: duration > 0 ? samples.length * 1000 / duration : null,
      allocationBytesPerSecond: duration > 0 ? totalAllocatedBytes * 1000 / duration : null,
      topFunctions,
    }
  } catch (error) {
    console.warn('分配采样收集失败:', error.message)
    return null
  } finally {
    if (client) {
      if (sampling) await client.send('HeapProfiler.stopSampling').catch(() => {})
      await client.send('HeapProfiler.disable').catch(() => {})
      await client.detach().catch(() => {})
    }
  }
}

/**
 * 获取 GC 后仍保留的脱离 DOM 节点。CDP 不提供其字节大小。
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('./types.mjs').DetachedElements|null>}
 */
export async function captureDetachedElements(page) {
  let client
  try {
    client = await page.target().createCDPSession()
    await client.send('HeapProfiler.enable')
    await client.send('HeapProfiler.collectGarbage')
    await client.send('DOM.enable')
    const { detachedNodes } = await client.send('DOM.getDetachedDomNodes')
    const ids = new Set()
    const visit = (node) => {
      ids.add(node.nodeId)
      for (const child of node.children ?? []) visit(child)
    }
    // retainedNodeIds 是已保留节点的子集；Chrome 实际返回 backend ID，
    // 不能与 treeNode.nodeId 合并计数。完整脱离树包含其余被连带保留的节点。
    for (const { treeNode } of detachedNodes) visit(treeNode)
    return {
      detachedCount: ids.size,
      detachedMemory: null,
      topDetached: detachedNodes.slice(0, 20).map(({ treeNode, retainedNodeIds }) => ({
        nodeId: treeNode.nodeId,
        nodeName: treeNode.nodeName,
        retainedCount: retainedNodeIds.length,
      })),
    }
  } catch (error) {
    console.warn('已分离元素收集失败:', error.message)
    return null
  } finally {
    if (client) {
      await client.send('DOM.disable').catch(() => {})
      await client.send('HeapProfiler.disable').catch(() => {})
      await client.detach().catch(() => {})
    }
  }
}

/**
 * 完整的内存收集流程
 * @param {import('puppeteer-core').Page} page
 * @param {Object} options
 * @returns {Promise<import('./types.mjs').MemoryMetrics|null>}
 */
export async function collectMemoryMetrics(page, options = {}) {
  const {
    captureHeap = true,
    captureTimeline = true,
    captureSampling = true,
    captureDetached = true,
    interactionCallback = null,
    timeoutMs = 10000,
    durationMs = 1000,
    samplingIntervalMs = 250,
  } = options

  const metrics = {
    heapSnapshot: null,
    allocationTimeline: null,
    allocationSampling: null,
    detachedElements: null,
    collectedAt: new Date().toISOString(),
  }

  const startTime = Date.now()

  try {
    if (captureHeap && Date.now() - startTime < timeoutMs) {
      metrics.heapSnapshot = await captureHeapSnapshot(page)
    }

    if (captureTimeline && Date.now() - startTime < timeoutMs) {
      metrics.allocationTimeline = await captureAllocationTimeline(page, interactionCallback, {
        durationMs: Math.min(durationMs, timeoutMs - (Date.now() - startTime)), samplingIntervalMs,
      })
    }

    if (captureSampling && Date.now() - startTime < timeoutMs) {
      metrics.allocationSampling = await captureAllocationSampling(page, interactionCallback, {
        durationMs: Math.min(durationMs, timeoutMs - (Date.now() - startTime)),
      })
    }

    if (captureDetached && Date.now() - startTime < timeoutMs) {
      metrics.detachedElements = await captureDetachedElements(page)
    }
  } catch (error) {
    console.error('内存指标收集过程中出错:', error.message)
  }

  return metrics
}
