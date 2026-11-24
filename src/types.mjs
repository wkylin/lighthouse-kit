// 共享类型（仅 JSDoc typedef，无运行时代码）。

/** @typedef {'command'|'static'|'url'} ServeMode */
/** @typedef {{ mode: ServeMode, command?: string, url?: string, static?: string, port: number, readyPath: string, proxy: Record<string,string>, timeoutMs: number }} ServeConfig */
/** @typedef {{ root: string, configFile: string, build: {command: string, env: Record<string,string>}|null, serve: ServeConfig,
 *   https: {enabled: boolean, port: number}, pages: string[], beforePage: ((ctx:{page:any, url:string, warmup:boolean}) => Promise<void>)|null,
 *   runs: number, visit: 'first'|'repeat', formFactor: 'mobile', categories: string[], chromePath: string|null,
 *   sourceMap: {manifest: string|null, maps: string|null}, docs: {audiences: ('dev'|'lead')[], lang: 'zh-CN'},
 *   ai: {enabled: boolean, model: string, apiKeyEnv: string, sourceRoot: string, maxFindings: number, exclude: string[]},
 *   outDir: string, keep: 'latest'|number }} Config */
/** @typedef {{ perf:number|null, a11y:number|null, bp:number|null, seo:number|null, agentic:{pass:number,total:number}|null }} Scores */
/** @typedef {{ fcp:number|null, lcp:number|null, tbt:number|null, cls:number|null, si:number|null }} Metrics */
/** warnings：Lighthouse 的 runWarnings（例如加载超时），各次去重合并；旧轮次的 summary 没有这一项。 */
/** @typedef {{ page:string, slug:string, ok:boolean, error:string|null, finalUrl:string|null, warnings?:string[], runs:{index:number, ok:boolean, error:string|null, scores:Scores, metrics:Metrics, warnings?:string[]}[], representative:number|null, median:{scores:Scores, metrics:Metrics}|null }} PageSummary */
/** @typedef {{ id:string, name:string|null, partial:boolean, pagesRequested:string[], origin:string, startedAt:string, finishedAt:string|null,
 *   status:'running'|'complete'|'failed-pages'|'aborted', failedPages:string[], lighthouseVersion:string, visit:string, formFactor:string, runs:number,
 *   git:{commit:string, dirty:boolean}|null, buildFingerprint:string|null }} RoundMeta */
/** @typedef {{ url?:string, selector?:string, snippet?:string, label?:string, ms?:number, bytes?:number, source?:{file:string, share:number}|null }} Evidence */
/** @typedef {{ id:string, category:string, group:string, title:string, advice:string, score:number, savings:{lcp:number,tbt:number,fcp:number,cls:number,bytes:number}, impact:number, evidence:Evidence[] }} Finding */
/** @typedef {Finding & { pages:string[], impactTotal:number, perPage:{page:string, impact:number, evidence:Evidence[]}[], ai:{cause:string, fix:string, model:string}|null }} MergedFinding */
/** @typedef {{ lcpElement:{selector:string, snippet:string}|null, lcpPhases:{phase:string, ms:number}[], topScripts:{url:string, ms:number, source:{file:string,share:number}|null}[] }} PageFacts */
/** aiSent：真正发送给 AI 的内容；aiPlanned：--ai-dry-run 时本会发送的内容（不进文档）。 */
/** @typedef {{ round:RoundMeta, pages:PageSummary[], findings:MergedFinding[], facts:Record<string,PageFacts>, aiSent:{finding:string, file:string, chars:number}[], aiPlanned?:{finding:string, file:string, chars:number}[] }} Analysis */
/** @typedef {{ roundId:string, name:string|null, partial:boolean, origin:string, lighthouseVersion:string, visit:string, formFactor:string, runs:number,
 *   git:{commit:string,dirty:boolean}|null, buildFingerprint:string|null, finishedAt:string, pages:Record<string,{scores:Scores, metrics:Metrics}> }} HistoryEntry */

export {}
