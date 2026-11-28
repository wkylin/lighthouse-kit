// 内存风险启发式；这些观测不提供 Lighthouse 分数收益。
import { MIN_MEMORY_OBSERVATION_MS } from '../memory-summary.mjs'

const MiB = 1024 * 1024
export const MEMORY_THRESHOLDS = Object.freeze({
  heapBytes: 100 * MiB,
  heapUsageRatio: 0.8,
  detachedCount: 10,
  detachedBytes: MiB,
  growthBytes: 10 * MiB,
  growthBytesPerSecond: 5 * MiB,
  allocationSamplesPerSecond: 100,
})

const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
const atLeast = (value, threshold) => valid(value) && value >= threshold
const mib = (bytes) => `${(bytes / MiB).toFixed(1)} MiB`

/** @returns {import('../types.mjs').Finding[]} */
export function memoryFindingsForPage(memory) {
  if (!memory) return []
  const findings = []
  const add = (id, title, advice, evidence) => findings.push({
    id, title, advice, evidence, category: 'memory', group: 'memory', score: null,
    savings: { lcp: 0, tbt: 0, fcp: 0, cls: 0, bytes: 0 }, impact: 0,
  })
  const heap = memory.heapSnapshot
  if (atLeast(heap?.usedJsHeapSize, MEMORY_THRESHOLDS.heapBytes) || atLeast(heap?.heapUsageRatio, MEMORY_THRESHOLDS.heapUsageRatio)) {
    const evidence = []
    if (valid(heap.usedJsHeapSize)) evidence.push({ label: `已用 JS 堆 ${mib(heap.usedJsHeapSize)}（高堆阈值 100 MiB）`, bytes: heap.usedJsHeapSize })
    if (valid(heap.heapUsageRatio)) evidence.push({ label: `堆上限使用率 ${(heap.heapUsageRatio * 100).toFixed(1)}%（阈值 80%）` })
    add('memory-high-heap', 'JavaScript 堆占用偏高',
      '用 DevTools 堆快照检查保留对象及引用链，限制缓存和大数组的生命周期，按需加载数据；同一业务场景复测，确认高堆是否持续。', evidence)
  }
  const detached = memory.detachedElements
  if (atLeast(detached?.detachedCount, MEMORY_THRESHOLDS.detachedCount) || atLeast(detached?.detachedMemory, MEMORY_THRESHOLDS.detachedBytes)) {
    const evidence = []
    if (valid(detached.detachedCount)) evidence.push({ label: `脱离 DOM 节点 ${detached.detachedCount} 个（阈值 10 个）` })
    if (valid(detached.detachedMemory)) evidence.push({ label: `脱离 DOM 占用 ${mib(detached.detachedMemory)}（阈值 1 MiB）`, bytes: detached.detachedMemory })
    add('memory-detached-elements', '脱离 DOM 节点较多，疑似内存泄漏',
      '反复执行组件挂载和卸载并在垃圾回收后比较堆快照，检查保留路径；清理事件监听器、定时器和对已移除节点的引用。单次脱离节点观测不能证明泄漏。', evidence)
  }
  const timeline = memory.allocationTimeline
  if (atLeast(timeline?.duration, MIN_MEMORY_OBSERVATION_MS) && atLeast(timeline?.growthRate, MEMORY_THRESHOLDS.growthBytes) && atLeast(timeline?.growthRatePerSecond, MEMORY_THRESHOLDS.growthBytesPerSecond)) {
    add('memory-rapid-growth', '观测期间 JavaScript 堆快速增长',
      '在相同交互和时长下复测增长趋势，检查无限追加的数据、缓存及未释放引用；配合垃圾回收后的堆快照区分临时分配与持续保留。',
      [{ label: `峰值堆增量 ${mib(timeline.growthRate)}（阈值 10 MiB），增长率 ${mib(timeline.growthRatePerSecond)}/s（阈值 5 MiB/s），观测 ${(timeline.duration / 1000).toFixed(1)} s`, bytes: timeline.growthRate }])
  }
  const sampling = memory.allocationSampling
  if (atLeast(sampling?.duration, MIN_MEMORY_OBSERVATION_MS) && atLeast(sampling?.allocationRate, MEMORY_THRESHOLDS.allocationSamplesPerSecond)) {
    const interval = valid(sampling.samplingInterval) ? `${sampling.samplingInterval / 1024} KiB` : '未知'
    add('memory-high-allocation-rate', '内存分配采样频率偏高',
      '在 DevTools Allocation Sampling 中定位分配热点，减少高频渲染或循环创建临时对象，复用可安全复用的缓冲区。样本率是分配压力的代理量，不是精确的对象分配次数；比较时保持采样间隔一致。',
      [{ label: `分配样本率 ${sampling.allocationRate.toFixed(1)} 样本/s（阈值 100 样本/s），采样间隔 ${interval}，观测 ${(sampling.duration / 1000).toFixed(1)} s` }])
  }
  return findings
}
