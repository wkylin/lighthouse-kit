# 多模型 API 与通用 Lighthouse skill

## 意图与范围

用户选择同时实现两种入口：CLI 可切换 OpenAI、Claude、DeepSeek 等模型 API；通用 skill 可复用 Codex、Claude Code 或以 DeepSeek 为后端的助手会话。两种入口共用 Lighthouse 扫描、规则分析、源码筛选和现有报告。

目标是从真实扫描证据得到项目内的原因与改法，并把建议合入原有开发版文档。skill 本身不绑定模型服务，也不需要额外的模型 API Key；执行它的宿主需要文件读写和终端能力。

用户补充的优先级：分析和建议准确，效率高，允许不同用户按需自定义，但普通使用保持简单。默认配置只需 `ai: { enabled: true, provider: 'deepseek' }` 这样的写法；其余选项提供默认值，并在文档中按“常用”和“进阶”分组。

不做新的扫描引擎、在线托管、自动发布、修改被扫项目的业务代码或自动安装到用户全局目录。保留上一轮 `--config` 文档更新。

## 方案比较

1. 仅扩展模型 API：CLI 可无人值守运行，但不能复用助手当前会话。
2. 仅提供通用 skill：助手可分析，但 CLI 仍绑定 Anthropic。
3. 同时提供 API 适配器与通用 skill，共用分析数据和报告。用户选择此方案。

以下字段和接口是实现建议，由实现者负责；不代表用户逐项指定。

## API 配置与兼容

`ai` 增加模型接入、分析范围、执行效率和业务偏好选项。保留现有字段，提供以下可选配置：

| 分组 | 字段 | 默认值与行为 |
|---|---|---|
| 常用 | `enabled`、`provider`、`model` | 默认关闭 AI，provider 默认为 Anthropic，模型按下表选择 |
| 接入 | `baseURL`、`apiKeyEnv` | 使用所选 provider 默认值，允许接入企业网关 |
| 接入 | `responseFormat` | `auto`；可设 `json-schema`、`json`、`text`，用于适配不同兼容服务 |
| 范围 | `sourceRoot`、`exclude`、`maxFindings` | 保持原默认值：源码目录、追加排除名单、最多 10 条 |
| 上下文 | `maxFileChars`、`maxFindingChars` | 8000、24000；可调小节约上下文，也可调大以检查长文件 |
| 效率 | `concurrency`、`cache` | 并发 2，最多 8；默认启用按输入内容匹配的本地缓存 |
| 耗时 | `timeoutMs`、`maxRetries`、`maxTokens` | 120000、1、16000；最多 3 次重试 |
| 偏好 | `instructions`、`language` | 无额外业务偏好、`zh-CN`；允许指定项目约束和回答语言 |

| provider | 默认模型 | 默认 Key 环境变量 | 默认 API 根地址 |
|---|---|---|---|
| `anthropic`（默认） | `claude-opus-5-5`（保持现有值） | `ANTHROPIC_API_KEY` | 使用 Anthropic SDK 默认值 |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `deepseek` | `deepseek-flash` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| `openai-compatible` | 必须显式配置 | `OPENAI_API_KEY` | 必须显式配置 |

`baseURL` 允许 HTTP/HTTPS 根地址或带版本前缀的地址，保留前缀、去除结尾斜线，不接受嵌入的账户密码、查询参数或 fragment。未知 provider、无效 URL、字段类型或范围错误在配置加载阶段报配置错误。`maxFileChars` 不得大于 `maxFindingChars`。Key 继续只从环境变量读取；不提供把任意配置字段透传为 HTTP header 或模型请求参数的入口。

Anthropic 继续使用现有可选 SDK、适用模型的服务端回退。其他三个 provider 使用 Node 内置 `fetch` 调用 `<baseURL>/chat/completions`，不新增生产依赖。OpenAI 用 `max_completion_tokens`，其余兼容接口用 `max_tokens`。`responseFormat: 'auto'` 时 Anthropic 和 OpenAI 使用 JSON schema，DeepSeek 与兼容接口使用 JSON object 模式；`text` 不发送格式参数，仍要求并校验 JSON 回答。

统一验证结构化回答，记录返回模型名。拒答、截断、无效 JSON、空回答或 API 失败回退规则建议；认证失败或连接/超时失败停止调度后续请求，允许已经在途的请求结束。仅对限流、服务端错误或连接/超时按 `maxRetries` 有限重试。维持每条进度输出、真正发送的源码记录和重新分析保留旧建议的行为。`--ai-dry-run` 不创建客户端、不发请求、不写缓存。

## 准确性与效率

每条新 AI 建议除 `cause`、`fix` 外，还包含：

- `confidence`：`high`、`medium` 或 `low`，表示证据充分程度；不把它当作模型正确率。
- `evidence`：`{file, quote}` 数组，引用实际交给模型的源码片段。文件必须在本条允许的源码清单中，引用必须能在实际片段里找到；不匹配则拒收本条建议，使用规则建议。
- `verification`：非空字符串数组，说明如何验证诊断、修改和回归。它们是报告中的建议，不会自动执行。

没有有效引用时只允许低置信度建议，并要求写明缺口与确认步骤。提示词要求：先区分 Lighthouse 实测和静态代码推断；说明改法为何针对该证据、适用前提及验证方法；不杜撰文件、行号、耗时、改善比例或已经完成的验证。`instructions` 可增加业务约束，不能替代上述证据要求。

源码片段附真实起始行与截断说明。长文件有可精确匹配的证据片段时，优先截取该位置附近的上下文；没有匹配则使用文件开头并明确上下文有限。提高字符预算可扩大上下文，缺失代码不能补猜。

开发版报告在原有原因和改法后显示证据充分程度、源码引用和验证步骤；已有只有 `cause`、`fix` 的历史建议继续可读。负责人版继续使用真实扫描指标，不把 AI 的估计当作新分数。

缓存位于 `<outDir>/ai-cache/`，缓存键包含请求协议、provider、根地址、请求模型、输出约束、提示词、站点证据和实际源码片段；输入变化自动失效。缓存命中仍校验建议与当前源码引用，不记为本次发送。`cache: false` 可强制重新请求。并发通过有界任务队列实现，不一次性启动全部请求；结果顺序保持现有问题顺序。

## 通用 skill 与 CLI 数据交换

发布 `skills/lighthouse-kit/SKILL.md`，使用标准 `name`、`description` frontmatter。文档描述发现配置、扫描或复用已有轮次、读取已筛选的证据、用当前模型分析、回写报告的完整流程。不使用某个宿主独有的工具名、变量插值或自动执行语法。

新增两个命令，均支持现有 `--config <目录>`：

- `lhkit ai-export [轮次]`：读取已生成的 `analysis.json`，将模型中立的任务写入 `<轮次>/ai/request.json`。无需 `ai.enabled` 或 API Key，不请求外部服务。缺省轮次仍为最近一个已结束的轮次。
- `lhkit ai-import <回答文件> [轮次]`：校验并导入助手生成的 JSON，更新该轮 `analysis.json`、开发版/负责人版 Markdown 与 HTML、总览。不重扫、不调用模型 API、不追加历史或创建新轮次。回答文件相对当前工作目录解析。

导出数据包含 `version: 1`、`requestId`、`roundId`、`analysisHash`、`system` 和 `tasks`。每个任务包含 `id`、`title`、含证据及源码片段的 `prompt`，以及 `{file, chars}` 源码清单。任务按现有优先级截取，最多 `ai.maxFindings` 个有源码的问题。导出本身不记为已发送。

回答格式：

```json
{
  "version": 1,
  "requestId": "原样复制导出值",
  "roundId": "原样复制导出值",
  "model": "实际模型名或 codex-session / claude-session 等会话标签",
  "findings": [{
    "id": "任务中的审计项 ID",
    "cause": "具体原因，区分实测与推断",
    "fix": "对应的改法与适用前提",
    "confidence": "medium",
    "evidence": [{ "file": "src/example.js", "quote": "从导出片段原样引用的代码" }],
    "verification": ["可复现的验证步骤"]
  }]
}
```

允许只回答一部分任务。整份文件在写入前校验：格式、版本、轮次、请求 ID、重复/未知审计项、空原因或改法、引用和验证步骤。请求 ID 绑定导出内容；`analysisHash` 忽略既有 AI 建议和发送清单，但绑定扫描和规则分析数据，防止把过期回答导入已变化的分析。导入前重新收集本批任务的源码并对照导出上下文，代码已经变化时要求重新导出。校验失败退出码为 2，原分析与文档不变。

导入只替换对应问题的 AI 建议与源码记录，保留其他问题和已有建议。只导入导出清单中的源码记录，不接受回答文件任意指定文件或字符数。重复导入同一回答不重复累计源码记录。

同一轮次的导入通过文件锁串行执行，持锁后重新读取最新分析，避免两份部分回答互相覆盖。新分析、文档和总览先在临时目录中完整生成，再安装到原目录；安装故障回滚原产物，回滚本身失败时保留备份并明确报错。

skill 在 `run`、`scan`、`analyze` 时使用现有 `--ai-dry-run`，确保会话模式不会额外调用配置中的模型 API；后续显式导出不受 `ai.enabled` 限制。根据 CLI 实际返回的轮次路径处理结果，避免猜测自定义 `outDir`。没有源码可用时说明 source map 缺口，不虚构代码原因。

## 数据与权限边界

API 和 skill 导出复用同一个源码收集器：仅限 `ai.sourceRoot`，始终排除凭据、密钥、环境文件、依赖、锁文件和已配置构建产物目录；`ai.exclude` 同时检查路径和符号链接实际目标。源码预算来自配置，默认每文件 8000 字符、每问题 24000 字符。

skill 将扫描证据和源码当作数据，只生成建议与报告，不把源码中的文字当作指令。导入过程不执行回答内容。CLI 已有默认行为保持不变。

## 发布与文档

将 `skills/` 加入 npm 发布文件列表，验证 tarball 包含 skill；无需提交仓库的 `.agents` / `.claude` 配置。README 提供 API 配置表、环境变量、兼容接口示例，以及从 npm 包或仓库复制 skill 到 Codex / Claude Code 项目目录的命令。同步配置类型、CLI 帮助、模板注释和设计文档。

Codex 通过 `$lighthouse-kit`，Claude Code 通过 `/lighthouse-kit` 调用；DeepSeek 在具备 Agent Skills 与终端能力的宿主中加载同一份 skill，也可直接使用 CLI 的 DeepSeek API 配置。

## 验证与完成条件

- 配置测试覆盖 provider 默认值、显式覆盖和非法字段，旧配置保持兼容。
- 通过注入的客户端/`fetch` 与本地服务验证三种 API 协议、URL 前缀、JSON 解析、拒答、截断、认证失败、超时和 dry-run 不联网。
- 用真实 Lighthouse 测试夹具验证导出、部分回写、旧建议保留、文档与总览更新、请求/轮次不匹配和错误输入无写入。
- 新增源码过滤测试覆盖符号链接指向排除目标；保留现有过滤测试。
- 准确性测试覆盖不存在的文件/引用、空验证步骤、缺少证据的高置信度结论；长文件上下文显示正确行号和截断。
- 效率测试覆盖并发上限、失败后停止排队、缓存命中不联网、源码/模型/提示词变化导致失效、关闭缓存与重试上限。
- 重试和完整正文超时在所有 provider 上统一控制；发送记录跨重试保留，耗尽重试的 HTTP 408 停止后续调度，缓存包含 Anthropic 实际网关地址。
- 验证并发部分导入不丢建议、生成失败不影响旧文件、安装失败回滚，源码排除覆盖隐藏依赖目录、隐藏锁文件及项目根目录的符号链接。
- 校验 skill frontmatter 与 npm tarball，从隔离临时目录验证 CLI 导出 → 模拟会话回答 → 导入全流程。
- 执行现有单元测试；有环境限制或既有失败时据实记录。不使用付费在线模型进行验证，不声称真实服务账号已验证。

## 参考

- [Agent Skills 开放规范](https://agentskills.io/specification)
- [Codex skill 与本地发现目录](https://developers.openai.com/codex/skills/)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [OpenAI Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [GPT-4.1 mini 支持的接口](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [DeepSeek API 模型、根地址和兼容协议](https://api-docs.deepseek.com/)
