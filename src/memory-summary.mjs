// 单次内存观测 → 页面中位数。速率和比例先逐次计算，避免比值的中位数被错误替换为中位数的比值。
import { median } from './docs/format.mjs'

export const MIN_MEMORY_OBSERVATION_MS = 1000

const number = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const observationDuration = (value) => value >= MIN_MEMORY_OBSERVATION_MS ? value : null

function timelineValues(timeline) {
  if (!timeline) return null
  const baselineMemory = number(timeline.baselineMemory)
  const peakMemory = number(timeline.peakMemory)
  const timestamps = (timeline.allocations ?? []).map((a) => number(a?.timestamp)).filter((n) => n != null)
  const duration = number(timeline.duration) ?? (timestamps.length > 1 ? Math.max(...timestamps) - Math.min(...timestamps) : null)
  const growthRate = baselineMemory != null && peakMemory != null
    ? Math.max(0, peakMemory - baselineMemory) : number(timeline.growthRate)
  return {
    samplingInterval: number(timeline.samplingInterval), baselineMemory, peakMemory, growthRate, duration: observationDuration(duration),
    growthRatePerSecond: duration >= MIN_MEMORY_OBSERVATION_MS && growthRate != null ? growthRate * 1000 / duration : null,
  }
}

function samplingValues(sampling) {
  if (!sampling) return null
  const duration = number(sampling.duration)
  const sampleCount = number(sampling.sampleCount)
  const totalAllocatedBytes = number(sampling.totalAllocatedBytes)
  const observed = duration >= MIN_MEMORY_OBSERVATION_MS
  return {
    samplingInterval: number(sampling.samplingInterval), duration: observationDuration(duration), sampleCount, totalAllocatedBytes,
    allocationRate: observed && sampleCount != null ? sampleCount * 1000 / duration : null,
    allocationBytesPerSecond: observed && totalAllocatedBytes != null ? totalAllocatedBytes * 1000 / duration : null,
  }
}

function values(memory) {
  const heap = memory.heapSnapshot
  const used = number(heap?.usedJsHeapSize)
  const limit = number(heap?.jsHeapSizeLimit)
  return {
    heapSnapshot: heap ? {
      usedJsHeapSize: used, totalJsHeapSize: number(heap.totalJsHeapSize), jsHeapSizeLimit: limit,
      heapUsageRatio: used != null && limit > 0 ? used / limit : null,
    } : null,
    allocationTimeline: timelineValues(memory.allocationTimeline),
    allocationSampling: samplingValues(memory.allocationSampling),
    detachedElements: memory.detachedElements ? {
      detachedCount: number(memory.detachedElements.detachedCount), detachedMemory: number(memory.detachedElements.detachedMemory),
    } : null,
  }
}

const hasValues = (section) => section && Object.values(section).some((v) => v != null)

// 缓存聚合的比例／速率已经逐次计算过，只验证值，不用其他字段的中位数重算。
function storedMemory(stored) {
  if (!Number.isInteger(stored.runs) || stored.runs < 1) return null
  const result = { runs: stored.runs }
  const shape = values(stored)
  for (const section of Object.keys(shape)) {
    const row = shape[section] && Object.fromEntries(Object.keys(shape[section]).map((key) => [key, number(stored[section][key])]))
    if (row && (section === 'allocationTimeline' || section === 'allocationSampling')) {
      row.duration = observationDuration(row.duration)
      if (row.duration == null) {
        for (const key of ['growthRatePerSecond', 'allocationRate', 'allocationBytesPerSecond']) if (key in row) row[key] = null
      }
    }
    result[section] = hasValues(row) ? row : null
  }
  return Object.values(result).some((row) => typeof row === 'object' && hasValues(row)) ? result : null
}

/**
 * 只聚合成功运行的有效字段；原始数组和 collectedAt 不是中位数，不放进聚合对象。
 * @param {{ok:boolean, memory?:import('./types.mjs').MemoryMetrics|null}[]} runs
 * @returns {import('./types.mjs').MemorySummary|null}
 */
export function aggregateMemory(runs = []) {
  const observations = runs.filter((r) => r.ok && r.memory).map((r) => values(r.memory))
    .filter((m) => Object.values(m).some(hasValues))
  if (!observations.length) return null
  const result = { runs: observations.length }
  for (const section of ['heapSnapshot', 'allocationTimeline', 'allocationSampling', 'detachedElements']) {
    const rows = observations.map((m) => m[section]).filter(hasValues)
    if (!rows.length) {
      result[section] = null
      continue
    }
    result[section] = Object.fromEntries(Object.keys(rows[0]).map((key) => [key, median(rows.map((r) => r[key]))]))
  }
  return result
}

/** 新轮次从全部成功运行计算；兼容只有代表运行内存或聚合数据的历史摘要。 */
export function memoryForSummary(summary) {
  if (!summary?.ok) return null
  const runs = summary.runs ?? []
  // 明确存在逐次数据时，不回退到可能过时的代表运行值。
  if (runs.some((r) => Object.hasOwn(r, 'memory'))) return aggregateMemory(runs)
  const stored = summary.median?.memory ?? summary.memory
  if (!stored) return null
  if (Object.hasOwn(stored, 'runs')) return storedMemory(stored)
  return aggregateMemory([{ ok: true, memory: stored }])
}
