# 多模型 AI 与通用 skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 同时提供可配置的模型 API 与复用当前助手会话的 Lighthouse skill，并使建议可核查、可写回报告。

**Architecture:** 共用源码筛选、任务提示和回答校验；协议适配器只负责请求与响应。CLI 导出/导入同一任务结构，继续使用原报告渲染器。

**Tech Stack:** Node >=22.19、JavaScript ESM、node:test、内置 fetch、现有可选 Anthropic SDK。

**Spec:** `docs/superpowers/specs/2026-11-26-multi-model-ai-design.md`

## Global Constraints

- 保留旧配置默认值；不新增生产依赖。
- 源码预算默认 8000/24000 字符；仅允许 sourceRoot 中未被排除的源码。
- 默认并发 2（1–8）、缓存开启、超时 120000ms、重试 1（0–3）、maxTokens 16000。
- 新建议带 confidence、evidence、verification；历史建议继续可读。
- 已授权直接实现；在当前工作区完成，无需逐步确认，不提交、发布或改全局配置。

## Review Focus

- 源码通过符号链接绕过排除名单或构建目录。
- 连接失败、限流、超时和并发调度的请求上限。
- 已改变的源码/配置被缓存或旧会话回答错误复用。
- 伪造文件或引用进入正式报告，错误导入破坏已有结果。
- npm 包或复制后的 skill 依赖仓库中未发布的文件。

## Task 1: 配置、源码上下文与 API 分析

**Files:** 修改 `src/config.mjs`、`src/ai/index.mjs`、`src/types.mjs`、`types/index.d.ts`；新增 `src/ai/sources.mjs`、`prompt.mjs`、`reply.mjs`、`providers.mjs`；测试 `test/config.test.mjs`、`test/ai.test.mjs`、`test/ai-providers.test.mjs`。

**Interfaces:** `normalizeConfig` 产出规范化 ai 字段；`collectSources(finding, config)` 产出 `{file,text,startLine,truncated,hash}`；`prepareTasks(analysis,config)` 产出 `{system,tasks:[{finding,sources,prompt}]}`；`requestFor(task,system,ai)` 生成协议参数；`parseReply(response,ai,sources)` 校验并产出新建议；`enrichWithAi` 保留原调用方式并可注入 fetch。

- [x] 配置 provider 默认值/覆盖与非法输入的测试先失败，再实现字段、类型和校验。
- [x] 源码实际路径过滤、预算、匹配片段与行号测试先失败，再抽取共用源码收集器。
- [x] 通过注入 fetch 验证真实协议边界：URL 前缀、schema/json/text、返回值、错误、超时与重试；实现适配器。
- [x] 并发上限、认证失败停止排队、缓存命中/失效与 dry-run 的行为测试先失败，再实现队列与缓存。
- [x] 执行 `node --test test/config.test.mjs test/ai.test.mjs test/ai-providers.test.mjs`，全部通过。

## Task 2: 会话任务导出、导入与报告

**Files:** 新增 `src/ai/exchange.mjs`、`test/ai-exchange.test.mjs`；修改 `src/cli.mjs`、`bin/lhkit.mjs`、`src/docs/dev.mjs`、`test/docs.test.mjs`。

**Interfaces:** `exportAiRequest(roundDir,analysis,config)` 写入并返回 request；`importAiReply(roundDir,analysis,config,reply)` 返回已完整校验的新分析；CLI `ai-export [轮次]`、`ai-import <文件> [轮次]` 均接受 `--config`。

- [x] 使用真实 Lighthouse 夹具，先测试 CLI 导出、部分回答导入和报告重新生成，再实现共用任务交换。
- [x] 拒绝未知/重复 ID、错误 requestId/roundId、过期源码、无效引用，错误时文件不变；重复导入不重复累计记录。
- [x] 报告显示证据充分程度、引用和验证步骤，并保持历史建议可读。
- [x] 执行 `node --test test/ai-exchange.test.mjs test/docs.test.mjs`，全部通过。

## Task 3: skill、文档与分发验证

**Files:** 新增 `skills/lighthouse-kit/SKILL.md`；修改 `package.json`、`src/init.mjs`、`README.md`、`docs/design.md`、`test/package.test.mjs`。

- [x] skill 使用当前会话分析已筛选任务；引用 CLI 实际路径，提供完整回答格式，不假定固定 outDir，不自动修改业务代码。
- [x] npm 包含 skill，复制 skill 后仅依赖已声明的 lhkit CLI。
- [x] 文档提供最小配置、常用/进阶参数、兼容网关和会话调用示例。
- [x] 运行 skill validator、完整单元测试和临时项目 CLI 闭环；通过模拟 HTTP 服务验证协议，不调用付费模型。
- [x] 使用执行计划要求的独立审阅者检查整个改动，修复实质问题并重新验证。

## 执行记录

基线：升级前的完整单元测试通过；本机服务测试需要放行回环监听，npm 缓存使用 `/private/tmp/lhkit-ai-npm-cache`。
实现和验证在用户指定工作区完成；Git 元数据只读，保留所有原有修改，不创建提交。

Task 1: complete — 配置、源码与 API 定向测试通过；新增并发、缓存、引用校验和超时测试通过。
Task 2: complete — 临时项目真实 CLI 子进程导出/导入及报告测试通过，错误输入无写入。
实现选择：沿用历史建议时增加 carried 标记，避免把历史结论当作本次重新核验的结果。
验证记录：skill validator 通过，npm tarball 包含 skill。完整测试首次仅因测试假定旧版 Anthropic 鉴权 header 失败；检查已安装 SDK 后测试兼容两种实际鉴权方式，生产逻辑无需修改。

Task 3: complete — skill 格式验证通过，npm tarball 包含完整 skill，CLI 子进程闭环与四种本机 HTTP 协议通过。
Final review: 独立审阅发现 6 项实质问题，均在一次修复轮次中完成回归验证。
Final: fixed 隐藏依赖/锁文件与符号链接根目录的排除绕过 — 两个源码回归测试 RED→GREEN。
Final: fixed Anthropic 完整正文超时、SDK 重试策略与注入传输 — 回归测试 RED→GREEN，统一外层 deadline/retry，SDK 内部重试关闭。
Final: fixed 实际 Anthropic 网关未进入缓存键 — 环境网关切换测试 RED→GREEN。
Final: fixed 并发部分导入丢数据、生成/安装故障破坏已有结果 — 并发导入、生成失败、安装失败三个测试 RED→GREEN；锁内重读，先暂存完整报告，再安装，失败回滚。
Final: fixed HTTP 408 耗尽重试后未停止队列、跨重试发送记录丢失 — 错误策略与发送状态回归测试 RED→GREEN。
Final validation: npm_config_cache=/private/tmp/lhkit-ai-npm-cache npm test → 133/133 通过；skill quick_validate → valid；git diff --check → 通过。未调用真实付费模型服务，未发布或提交。
