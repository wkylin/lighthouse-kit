# lighthouse-kit（lhkit）

与框架无关的本地 Lighthouse 工具：按项目配置 **构建 → 起服务（或直接扫给定网址）→ 逐页扫描 → 规则分析（可选 AI）→ 生成开发版与负责人版文档 → 浏览器里看总览、每页报告和文档**。Vue、React 或任何能“构建 + 起服务”的前端项目都能用。

设计见 [docs/design.md](docs/design.md)。

## 要求

- Node ≥ 22.19（Lighthouse 13 的要求）
- macOS 或 Linux，本机装有 Chrome / Chromium（或用 `CHROME_PATH` / 配置 `chromePath` 指定）

## 安装

在要扫描的项目里安装为开发依赖（推荐，版本跟着项目走，配置文件也有类型提示）：

```bash
npm install -D lighthouse-kit
# 或
pnpm add -D lighthouse-kit
yarn add -D lighthouse-kit
```

然后：

```bash
npx lhkit init     # 生成 lhkit.config.mjs，按项目改好
npx lhkit run      # 构建 → 起服务 → 扫描 → 出文档 → 打开总览
```

也可以写进项目的 `package.json`：`"scripts": { "perf": "lhkit run", "perf:scan": "lhkit scan" }`。

不想装进项目时，直接 `npx lighthouse-kit init` / `npx lighthouse-kit run`。

### 本地开发版（link）

改 lighthouse-kit 本身、想在项目里马上试时，用本地链接代替 npm 上的版本：

```bash
# npm：先在 lighthouse-kit 仓库里注册一次，再到项目里链接
cd /path/to/lighthouse-kit && npm link
cd /path/to/your-project && npm link lighthouse-kit

# pnpm：直接把本地目录加成依赖
pnpm add -D link:/path/to/lighthouse-kit
```

取消链接：npm 用 `npm unlink lighthouse-kit`（项目里）和 `npm unlink -g lighthouse-kit`；pnpm 用 `pnpm remove lighthouse-kit` 后重新 `pnpm add -D lighthouse-kit`。

## 配置

默认在当前工作目录依次查找 `lhkit.config.mjs`、`lhkit.config.js`（`lhkit init` 可生成 `.mjs` 模板）。通常在项目根目录运行，配置示例：

```js
/** @type {import('lighthouse-kit').UserConfig} */
export default {
  build: { command: 'npm run build -- --sourcemap hidden' },
  // 三选一：项目自己的服务命令；工具托管构建目录；或只写网址扫描外部服务
  serve: { static: 'dist' },
  // serve: { command: 'npm run preview', url: 'http://localhost:4173', readyPath: '/' },
  // serve: { url: 'https://staging.example.com' },
  pages: ['/', '/about'],
  sourceMap: { manifest: 'dist/.vite/manifest.json', maps: 'dist' },
  docs: { audiences: ['dev', 'lead'] },
  ai: { enabled: false },
}
```

第一行的 `@type` 注释让 VS Code 等编辑器给出字段补全和类型检查，不需要额外 import（用 npx 运行也没问题）。lighthouse-kit 装在项目里时也可以写成：

```js
import { defineConfig } from 'lighthouse-kit'

export default defineConfig({ serve: { static: 'dist' }, pages: ['/'] })
```

从其他目录运行时，用 `--config <目录>` 指定配置所在的项目目录：

```bash
npx lhkit init --config ./apps/web       # 在已有的 apps/web 目录生成配置模板
npx lhkit run --config ./apps/web        # 使用 apps/web 中的配置跑全流程
npx lhkit scan /about --config /path/to/your-project
```

所有命令都支持 `--config`，参数是**目录，不是配置文件路径**。目录可用绝对路径，也可用相对于当前工作目录的路径。指定后，工具在该目录查找配置，并以它作为项目根目录：构建和服务命令在此执行，配置中的相对路径（如 `serve.static`、`sourceMap.maps`、`ai.sourceRoot`、`outDir`）也以此为基准，默认结果输出到该目录的 `.lhkit/`。

全部字段和说明见 [types/index.d.ts](types/index.d.ts)，设计细节见 [docs/design.md](docs/design.md) 的“配置文件”一节。几点说明：

- 字段类型不对（端口、次数、超时、`categories` 等）直接报配置错误，不会悄悄改成别的值。
- 每个页面对应一个结果目录。会落到同一个目录的两条（例如 `/` 和 `/root`、`/foo` 和 `/foo/`）报配置错误。
- `serve.static`：工具自带的静态服务。带内容哈希的文件（如 `index-3f2a9c1b.js`）按 `immutable` 长期缓存，其余文件 `no-cache`。有 `.br`/`.gz` 预压缩文件就直接用，没有就对文本文件即时 gzip。`proxy` 的目标地址带路径时保留这段路径，WebSocket 也一样。
- 工具起的静态服务和 HTTPS（HTTP/2）前置代理只监听 `127.0.0.1`。
- 站点部署在子路径时（`serve.url` 带路径，如 `http://localhost:4173/app/`），源码对照会先去掉这段前缀。
- `ai.sourceRoot` 默认：项目有 `src/` 就用 `src/`，否则用项目根目录。

## 命令

| 命令 | 作用 |
|---|---|
| `lhkit init` | 生成配置模板 |
| `lhkit run [页面…]` | 全流程，最后打开总览 |
| `lhkit build` | 只构建 |
| `lhkit scan [页面…]` | 不构建：起服务、扫描、分析、出文档 |
| `lhkit analyze [轮次]` | 对已有轮次重新分析、出文档 |
| `lhkit preview [轮次]` | 打开总览 |
| `lhkit compare <A> <B>` | 对比两个轮次 |
| `lhkit ai-export [轮次]` | 导出供当前助手分析的证据和源码任务，不调用模型 API |
| `lhkit ai-import <回答文件> [轮次]` | 校验助手建议并写回报告，不重扫、不调用模型 API |

常用参数：`--config DIR`（指定配置所在目录，所有命令均支持）、`--runs N`（每页次数，取中位数）、`--name X`（命名轮次，不会被自动清理）、`--url U`（临时改扫外部地址）、`--ai-dry-run`（只列出 AI 会发送的内容，不发送）。

- 参数只能用在支持它的命令上（例如 `compare` 不接受 `--runs`），用错了按配置错误退出。
- Chrome、构建目录和端口在开始前就检查。缺了或被占用时直接报错，不会先跑一遍构建。

## 输出

结果在项目的 `.lhkit/`（请加入 `.gitignore`）：每轮一个目录，含总览 `index.html`、每页 `lighthouse.json|html`、`analysis.json`、`docs/dev.md|html`、`docs/lead.md|html`、`logs/`（`build.log`、`serve.log`，以及命令行输出的完整记录 `scan.log`）。`history/` 保存每轮的小汇总。

- 不带 `--name` 的完整轮次只保留最新一轮（`keep: 'latest'`，新一轮全部页面成功后才删上一轮）；`--name` 命名的轮次和只扫部分页面的轮次不会自动删除。
- 被中断的轮次（Ctrl+C、kill）标为 `aborted`，不写历史，也不会被自动清理。`run`/`scan` 结束时会列出这些轮次以及没有正常结束的轮次。用同一个 `--name` 重跑上次中断的命名轮次，会清掉旧目录重来。
- 页面在 Lighthouse 的限定时间（45 秒）内没有加载完时照常出分，但扫描输出和两份文档都会标“加载超时，结果可能不完整”。
- 开发版文档会列出有多少本站 JS/CSS 文件没能对到源码，并说明怎么补 source map。
- 轮次里记录的 git 信息只看已跟踪文件的改动。未跟踪的新文件（例如 `lhkit.config.mjs`）不算“有未提交的改动”。
- 退出码：0 成功；1 运行失败或被中断；2 配置错误；3 端口被占用或服务未就绪；4 部分页面失败（文档照常生成）。
- `LHKIT_NO_OPEN=1` 时不自动打开浏览器（CI、脚本里用）。

## 对比新旧版本

```bash
git switch <旧提交> && lhkit run --name base
git switch <新提交> && lhkit run --name new
lhkit compare base new
```

两轮的目标地址、Lighthouse 大版本、访问方式、设备或每页次数不同时，对比页顶部有一行提示，说明分数不能直接比较。任一轮只扫了部分页面、中途中断或没有正常结束时，同一行也会标出来。

## 可选：AI 分析

可以让 CLI 调用模型 API，也可以通过通用 skill 复用 Codex、Claude Code 等助手当前会话的模型。两种方式共用源码筛选和建议校验，建议写入已有开发版报告，负责人版指标仍来自真实 Lighthouse 扫描。

### 通过模型 API 自动分析

在 `lhkit.config.mjs` 中只需开启 AI、选择服务商：

```js
ai: { enabled: true, provider: 'deepseek' },
```

然后设置对应环境变量并照常运行 `lhkit run` 或 `lhkit scan`。不写 `provider` 时保持原有 Anthropic 行为。

| `provider` | 默认模型 | 默认 Key 环境变量 | 默认 API 根地址 |
|---|---|---|---|
| `anthropic` | `claude-opus-5-5` | `ANTHROPIC_API_KEY` | Anthropic SDK 默认地址 |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `deepseek` | `deepseek-flash` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| `openai-compatible` | 必须指定 `model` | `OPENAI_API_KEY` | 必须指定 `baseURL` |

模型名可以通过 `model` 自定义。OpenAI 与 DeepSeek 使用 Chat Completions 接口；Codex 是助手入口，通过下方 skill 使用当前会话。接口格式参考 [OpenAI](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 和 [DeepSeek](https://api-docs.deepseek.com/)。

常用配置按需增加：

```js
ai: {
  enabled: true,
  provider: 'openai-compatible',
  baseURL: 'https://gateway.example.com/v1',
  model: 'your-model',
  apiKeyEnv: 'LHKIT_API_KEY',
  sourceRoot: 'src',
  exclude: ['**/private/**'],
  maxFindings: 10,
  instructions: '保持 SSR 和现有交互，优先改善首屏性能。',
},
```

进阶选项都有默认值：

| 选项 | 默认值 | 用途 |
|---|---|---|
| `responseFormat` | `auto` | Anthropic/OpenAI 使用 JSON schema，DeepSeek/兼容服务使用 JSON；也可设 `json-schema`、`json` 或 `text`。`text` 不传格式参数，仍要求并校验 JSON 回答 |
| `maxFileChars` / `maxFindingChars` | `8000` / `24000` | 每文件/每问题的源码字符预算；前者不能大于后者，长文件可适当调大 |
| `concurrency` | `2` | 同时分析的问题数，范围 1–8；设为 1 可顺序分析 |
| `cache` | `true` | 有效建议缓存到 `<outDir>/ai-cache/`；模型、提示、证据或源码变化后失效；设为 `false` 强制重新请求 |
| `timeoutMs` | `120000` | 每次请求的超时毫秒数，覆盖连接、响应头及完整正文 |
| `maxRetries` | `1` | 临时网络错误、限流、服务端错误的重试次数，范围 0–3；鉴权错误不重试 |
| `maxTokens` | `16000` | 回答 token 上限，推理模型也可能用于推理 token |
| `language` | `zh-CN` | AI 建议的回答语言；报告固定栏目仍为中文 |

`baseURL` 保留 `/v1` 等路径前缀，不能包含账户密码、查询参数或 fragment。兼容服务需要 Key 时设置 `apiKeyEnv` 对应环境变量；不鉴权的本地服务也需设置一个非空占位 Key。网关不支持格式参数时可设 `responseFormat: 'text'`。Anthropic 的 `json` / `text` 通过提示要求 JSON，不使用 schema 约束。

Anthropic 也兼容原有 `ANTHROPIC_BASE_URL` 环境变量，显式 `baseURL` 配置优先；实际网关地址参与缓存匹配，切换地址后不会复用另一网关的建议。

每条新建议包含原因、改法、证据充分程度、源码引用和验证步骤。引用必须逐字存在于本次提供的源码中；不存在的文件、引用或不完整回答会被拒收，保留规则建议。证据不足时标为低置信度并列出待确认项。引用校验不代替运行验证，优化效果应按建议的方法复测。重新分析未拿到新建议时保留历史建议，并标注“本次未重新核验”。

只处理排名靠前、能关联到源码的问题（默认最多 10 条）。以下文件始终排除：`.env*`、`.npmrc`/`.netrc` 等凭据、私钥与证书、`node_modules`、锁文件、构建产物及结果目录。符号链接的实际目标也检查源码范围和排除规则。用 `ai.exclude` 追加排除规则；相对 glob 以项目根目录为基准，绝对 glob 按绝对路径匹配。先看会发送哪些片段：`lhkit scan --ai-dry-run`，此时不请求 API、不写缓存。没有 Key、请求失败或建议无效时使用规则建议；鉴权或连接故障在重试上限后停止后续调度，已在途的请求可正常结束。

### 通过通用 skill 使用当前助手

仓库和 npm 包都包含 [skills/lighthouse-kit/SKILL.md](skills/lighthouse-kit/SKILL.md)，遵循 [Agent Skills 规范](https://agentskills.io/specification)。复制到目标项目中即可使用，不需要为 CLI 另配模型 API Key：

```bash
# 已在目标项目安装含有 ai-export / ai-import 的 lighthouse-kit 版本后
# Codex（项目级）
mkdir -p .agents/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .agents/skills/

# Claude Code（项目级）
mkdir -p .claude/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .claude/skills/
```

本地 link 开发时，也可从本仓库的 `skills/lighthouse-kit` 复制。个人目录分别为 `~/.agents/skills/` 和 `~/.claude/skills/`，见 [Codex 发现规则](https://developers.openai.com/codex/skills/) 和 [Claude Code 安装位置](https://code.claude.com/docs/en/skills)。

Codex 输入“用 `$lighthouse-kit` 分析这个项目”，Claude Code 输入 `/lighthouse-kit`。以 DeepSeek 为后端、支持 Agent Skills 且能读写文件和运行命令的宿主，可加载同一份 skill。只有聊天界面时，需要手动导出任务、保存模型回答后再导入。

也可以手动运行完整流程：

```bash
# 会话分析模式：保证不额外调用配置中的模型 API
LHKIT_NO_OPEN=1 lhkit run --name review --ai-dry-run --config ./apps/web
lhkit ai-export review --config ./apps/web
# 让助手读取输出指向的 ai/request.json，按 skill 中的格式生成回答 JSON
lhkit ai-import ./reply.json review --config ./apps/web
```

已有扫描结果时直接 `ai-export` 即可，省略轮次时选最近一轮已结束的结果。`ai-export` 无需打开 `ai.enabled`；导出本身不记作已发送。回答需带本次导出的 `requestId`、`roundId`、实际模型名或会话标签，以及带引用和验证步骤的 `findings`。完整格式见 skill。

`ai-import` 支持只回答部分任务，重复导入不重复累计源码记录。同一轮次的导入串行执行，先生成完整产物再替换，替换失败时回滚。整批校验通过后才更新该轮分析和报告，不调用 API、不重扫、不新增轮次或历史；校验失败退出码为 2，原分析与文档不变。导出后源码或分析配置变化时需重新导出。回答文件相对执行命令时的工作目录解析，与 `--config` 分开。

## 发布到 npm（维护者）

```bash
npm login                      # 首次
npm version patch              # 或 minor / major：改版本号并打 tag
npm publish                    # 发布前会自动跑单元测试（prepublishOnly）
git push --follow-tags
```

发布的包只含 `bin/`、`src/`、`types/`、`skills/`、README 和 LICENSE（见 `package.json` 的 `files`）。发布前可用 `npm pack --dry-run` 查看内容。
