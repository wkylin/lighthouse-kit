// 规则库：Lighthouse 13 审计 id → 类别、中文标题、修改建议。

/** 类别的展示顺序（负责人版的类别分布、开发版的分组都按它）。 */
export const CATEGORY_ORDER = [
  'lcp',
  'main-thread',
  'javascript',
  'render-blocking',
  'network',
  'images',
  'animation',
  'layout-shift',
  'cache',
  'third-party',
  'css',
  'fonts',
  'dom',
  'bfcache',
  'viewport',
  'other',
  'accessibility',
  'best-practices',
  'seo',
  'agentic-browsing',
]

/** 类别的中文名。 */
export const CATEGORY_LABELS = {
  lcp: '最大内容绘制（LCP）',
  'main-thread': '主线程与脚本执行',
  javascript: 'JavaScript 体积',
  'render-blocking': '渲染阻塞',
  network: '网络请求链',
  images: '图片',
  animation: '动画',
  'layout-shift': '布局偏移',
  cache: '缓存',
  'third-party': '第三方',
  css: 'CSS',
  fonts: '字体',
  dom: 'DOM 规模',
  bfcache: '往返缓存',
  viewport: '视口',
  other: '其他性能问题',
  accessibility: '无障碍',
  'best-practices': '最佳实践',
  seo: 'SEO',
  'agentic-browsing': 'Agentic Browsing',
}

/** @type {Record<string, {category: string, title: string, advice: string}>} */
export const RULES = {
  'bootup-time': {
    category: 'main-thread',
    title: '脚本执行耗时过长',
    advice: '找出执行最久的脚本：首屏用不到的模块改为按需加载（动态 import / 路由级拆分），重复计算挪出渲染路径，长循环分片或放到空闲时执行。',
  },
  'mainthread-work-breakdown': {
    category: 'main-thread',
    title: '主线程工作量过大',
    advice: '按类别看耗时最多的是脚本执行、样式计算还是布局：减少首屏同时挂载的组件，避免一次性渲染大列表（虚拟列表），合并重复的样式读写。',
  },
  'long-tasks': {
    category: 'main-thread',
    title: '存在长任务',
    advice: '把超过 50ms 的任务拆小：大计算分批（requestIdleCallback / setTimeout 让出主线程），非首屏初始化延后到空闲时。',
  },
  'forced-reflow-insight': {
    category: 'main-thread',
    title: '强制同步布局',
    advice: '先批量读取布局（offsetHeight、getBoundingClientRect），再统一写样式；避免在循环里读写交替。',
  },
  'unused-javascript': {
    category: 'javascript',
    title: '加载了未使用的 JavaScript',
    advice: '首屏不需要的代码按路由或按交互拆分成独立 chunk；检查是否整包引入了只用到一小部分的库（改按需引入）。',
  },
  'legacy-javascript-insight': {
    category: 'javascript',
    title: '为新浏览器打包了旧式 JavaScript',
    advice: '调整构建目标（browserslist / build.target），去掉现代浏览器不需要的 polyfill 和语法转换。',
  },
  'duplicated-javascript-insight': {
    category: 'javascript',
    title: '重复打包的 JavaScript 模块',
    advice: '同一依赖出现多个版本或被打进多个 chunk：统一依赖版本，调整拆包策略让公共模块只打一份。',
  },
  'unused-css-rules': {
    category: 'css',
    title: '加载了未使用的 CSS',
    advice: '按页面或组件拆分样式，移除不再使用的全局样式；首屏只内联关键 CSS。',
  },
  'lcp-breakdown-insight': {
    category: 'lcp',
    title: 'LCP 各阶段耗时',
    advice: '看耗时最多的阶段：首字节慢查服务端；资源加载慢提前发现并预加载；元素渲染延迟大说明内容要等脚本或接口，考虑先用已有数据渲染。',
  },
  'lcp-discovery-insight': {
    category: 'lcp',
    title: 'LCP 资源发现得太晚',
    advice: 'LCP 图片不要懒加载，给它 fetchpriority="high"，必要时在 HTML 里 <link rel="preload">。',
  },
  'render-blocking-insight': {
    category: 'render-blocking',
    title: '渲染被阻塞的请求',
    advice: '阻塞首屏的样式和脚本：关键 CSS 内联、其余异步加载；脚本加 defer / type="module"，非必要的不要放在首屏同步路径。',
  },
  'network-dependency-tree-insight': {
    category: 'network',
    title: '关键请求链过长',
    advice: '缩短串行请求：能并行的接口一起发，关键资源提前 preload / preconnect，减少“请求完一个才知道下一个”的链路。',
  },
  'document-latency-insight': {
    category: 'network',
    title: '文档请求延迟',
    advice: '检查 HTML 的服务端响应时间、重定向和压缩；HTML 应启用压缩并尽量命中缓存。',
  },
  'modern-http-insight': {
    category: 'network',
    title: '未使用 HTTP/2 或更新协议',
    advice: '为静态资源和接口启用 HTTP/2 或 HTTP/3，减少连接开销。',
  },
  redirects: {
    category: 'network',
    title: '存在重定向',
    advice: '让入口链接直接指向最终地址，避免多次跳转。',
  },
  'image-delivery-insight': {
    category: 'images',
    title: '图片体积或格式可以优化',
    advice: '按显示尺寸提供图片（srcset / 合适的尺寸），使用 WebP / AVIF，首屏以下的图片 loading="lazy"。',
  },
  'cache-insight': {
    category: 'cache',
    title: '静态资源缓存时间过短',
    advice: '带哈希的静态资源设置长缓存（Cache-Control: max-age=31536000, immutable）；第三方资源确认其缓存策略。',
  },
  'third-parties-insight': {
    category: 'third-party',
    title: '第三方资源的影响',
    advice: '评估每个第三方的必要性，首屏不需要的延后加载，大图片走自己的 CDN 或压缩后再用。',
  },
  'non-composited-animations': {
    category: 'animation',
    title: '动画未在合成线程上运行',
    advice: '动画只改 transform 和 opacity；需要的阴影、颜色变化放到伪元素上做透明度渐变，不要直接动画 box-shadow、left、background-position 或自定义属性。',
  },
  'cls-culprits-insight': {
    category: 'layout-shift',
    title: '布局偏移的来源',
    advice: '为图片、广告位、异步内容预留尺寸（width/height、aspect-ratio、骨架屏），字体使用 size-adjust 或 font-display 避免跳动。',
  },
  'dom-size-insight': {
    category: 'dom',
    title: 'DOM 节点过多',
    advice: '长列表用虚拟滚动，折叠区域按需渲染，减少多余的包裹层级。',
  },
  'font-display-insight': {
    category: 'fonts',
    title: '字体加载期间文字不可见',
    advice: '@font-face 设置 font-display: swap 或 optional，关键字体 preload。',
  },
  'bf-cache': {
    category: 'bfcache',
    title: '页面无法使用往返缓存',
    advice: '按列出的原因处理：避免 unload 事件、未关闭的连接（WebSocket 在 pagehide 时关闭、pageshow 时重连）和 Cache-Control: no-store。',
  },
  'viewport-insight': {
    category: 'viewport',
    title: '视口未针对移动设备优化',
    advice: '设置 <meta name="viewport" content="width=device-width, initial-scale=1">，不要禁止缩放。',
  },
}
