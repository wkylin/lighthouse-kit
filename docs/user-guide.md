# lighthouse-kit 用户操作手册

适用于 lighthouse-kit 0.2.x，面向需要扫描前端项目、解读 Lighthouse 结果和生成优化方案的开发者。命令在 macOS 或 Linux 终端执行；下文使用 npm，pnpm 或 Yarn 项目只需替换安装、构建和服务命令。

第一次使用按“安装 → 配置 → 扫描 → 看报告”操作。完成普通扫描后，再选择模型 API 自动分析，或让 Codex、Claude Code 等助手通过 skill 使用当前会话分析。

## 1 选择使用方式

| 方式 | 适合什么场景 | 需要什么 | 如何启动 |
|---|---|---|---|
| 普通扫描与规则分析 | 先获取分数、指标和基础建议 | Node、Chrome、lhkit 配置 | `npx lhkit run` |
| 模型 API 分析 | 希望终端命令自动完成 AI 分析 | 普通扫描环境、模型 API Key | 开启 `ai.enabled` 后运行 `run`、`scan` 或 `analyze` |
| 助手 skill 分析 | 正在 Codex、Claude Code 等助手里工作 | 普通扫描环境、skill、可读写文件和运行命令的助手 | 在助手中调用 `$lighthouse-kit` 或 `/lighthouse-kit` |

API 模式使用你配置的模型服务和 API 凭据。skill 模式由助手当前会话完成分析，无需为 lhkit 另配模型 API Key。两者都需要 lhkit CLI；安装 skill 不会代替 CLI 的安装。

## 2 安装并确认环境

进入**要扫描的业务项目**，不是 lighthouse-kit 工具仓库。先查看业务项目的 `packageManager` 和锁文件，使用项目原有的包管理器；下面先给出 npm 项目示例，pnpm workspace 用户使用本节后面的命令：

```bash
cd /path/to/your-project
node --version
npm install -D lighthouse-kit@0.2.1
npx lhkit --version
npx lhkit --help
```

确认输出版本为 `0.2.1` 或后续兼容版本，帮助中存在 `ai-export` 和 `ai-import`。

- Node 要求 ≥22.19，建议使用符合该要求的 Node LTS。
- 本机需要安装 Chrome 或 Chromium。
- lhkit 当前支持 macOS、Linux，扫描模式为手机模式。
- 构建依赖由业务项目管理；运行前先完成该项目自己的依赖安装。

pnpm 和 Yarn 的安装方式：

```bash
pnpm add -D lighthouse-kit@0.2.1
# 或
yarn add -D lighthouse-kit@0.2.1
```

如果 pnpm 报 `ERR_PNPM_ADDING_TO_ROOT`，说明当前目录是 workspace 根目录。当应用就在根目录，或希望在根目录统一安装扫描工具时，显式加 `-w`：

```bash
pnpm add -Dw lighthouse-kit@0.2.1
pnpm exec lhkit --version
pnpm exec lhkit --help
```

`-D` 表示开发依赖，`-w` 表示 workspace 根目录。需要安装到某个子包时，在子包目录执行 `pnpm add -D`，或用 `pnpm --filter 包名 add -D lighthouse-kit@0.2.1`；包名替换为目标子包的 `package.json` 中的 `name`。[pnpm 安装参数](https://pnpm.io/cli/add)

本手册后面的 `npx lhkit …`，在 pnpm 项目中可以写为 `pnpm exec lhkit …`。例如初始化使用 `pnpm exec lhkit init`，扫描使用 `pnpm exec lhkit run`。

如果使用本地开发中的 lighthouse-kit，按 [README 安装一节](../README.md#安装) 中的本地开发链接说明接入业务项目，后续操作相同。

## 3 完成第一次扫描

### 3.1 生成配置

```bash
npx lhkit init
```

项目根目录会生成 `lhkit.config.mjs`。工具会参考项目的构建、预览脚本生成初始配置；生成后需要确认命令、端口和目录符合项目实际情况。

已有配置时直接编辑，不必重复 `init`。只有确定要覆盖配置时才使用 `init --force`。

### 3.2 配置一个 Vite 静态项目

下面是一份完整的 `lhkit.config.mjs`，适用于构建输出为 `dist/`、构建脚本为 `vite build` 的项目：

```js
/** @type {import('lighthouse-kit').UserConfig} */
export default {
  build: {
    command: 'npm run build -- --sourcemap hidden --manifest',
  },
  serve: {
    static: 'dist',
    port: 4173,
  },
  pages: ['/'],
  sourceMap: {
    manifest: 'dist/.vite/manifest.json',
    maps: 'dist',
  },
  docs: { audiences: ['dev', 'lead'] },
  ai: { enabled: false },
}
```

先只扫真实存在的首页。确认流程可用后，再把项目中的实际路径加入 `pages`，例如 `['/', '/products', '/about']`。

这里的 `--sourcemap hidden --manifest` 是 Vite 参数，用于生成源码映射和文件清单；`hidden` 不会在生成的 JS 中添加 source map 引用。对应 Vite 配置项为 `build.sourcemap: 'hidden'`、`build.manifest: true`。[Vite 构建选项](https://vite.dev/config/build-options.html)

其他构建工具使用项目自己的构建命令，不要直接套用 Vite 参数。`serve` 的其他模式见第 4 节。

### 3.3 开始扫描

```bash
npx lhkit run --name first-review
```

执行顺序为构建、启动目标服务、逐页扫描、分析、生成报告，最后打开浏览器总览。

终端会输出实际轮次目录和文档路径。使用上面的默认配置时，结果位于：

```text
.lhkit/runs/first-review/
```

再次查看：

```bash
npx lhkit preview first-review
```

`--name` 是结果轮次的名称。每次新扫描换一个未使用的名称，例如 `first-review-2`；名称以字母或数字开头，只能包含字母、数字、点、下划线和连字符。

将 `.lhkit/` 加入业务项目的 `.gitignore`。命名轮次不会被工具自动清理。

## 4 按项目选择扫描目标

`serve` 配置保留一种模式；`command` 和 `static` 不能同时使用。

### 4.1 托管已经构建的静态目录

在配置中使用：

```js
serve: {
  static: 'dist',
  port: 4173,
},
```

这是配置对象中的 `serve` 字段片段，其他字段保留。有 `build` 命令时用 `run`；已经构建好时可以只扫描：

```bash
npx lhkit scan --name static-review
```

`scan` 不会执行构建，使用它之前必须已有正确的构建目录。

### 4.2 运行项目自己的服务

需要项目预览服务、SSR 或自己的服务器逻辑时，配置项目中实际存在的服务命令：

```js
serve: {
  command: 'npm run preview',
  url: 'http://localhost:4173',
  readyPath: '/',
  timeoutMs: 60000,
},
```

确认服务命令真正监听 `url` 指定的端口。工具等待就绪路径可访问后开始扫描，结束时停止它启动的服务。

0.2.0 在启动服务时发现端口被占用，会尝试结束占用该端口的进程。运行前选择空闲端口；如果要复用已经启动的服务，使用下一种网址模式。

### 4.3 扫描已启动的服务或外部网站

完整的最小网址配置：

```js
export default {
  serve: { url: 'https://staging.example.com' },
  pages: ['/'],
  ai: { enabled: false },
}
```

```bash
npx lhkit scan --name staging-review
```

网址模式不构建、不启动目标服务。也可以对现有配置临时覆盖目标地址：

```bash
npx lhkit scan --url https://staging.example.com --name staging-review-2
```

`--url` 支持 `run` 和 `scan`；覆盖为网址模式后，即使用 `run` 也不执行构建。

只有网站地址、没有匹配的本地源码和映射时，可以获得扫描指标和规则建议，但源码级 AI 分析可能没有可用任务。扫描远程部署时，使用与该部署一致的源码和构建映射。

### 4.4 在其他目录运行

从仓库根目录扫描某个子项目：

```bash
npx lhkit run --config ./apps/web --name web-review
```

`--config` 接收**配置所在目录**，支持相对目录或绝对目录。默认在该目录依次查找 `lhkit.config.mjs`、`lhkit.config.js`。构建和服务命令在该项目目录执行，`serve.static`、`sourceMap`、`ai.sourceRoot`、`outDir` 等相对路径也以该目录为基准。

不要传 `--config ./apps/web/lhkit.config.mjs`。

### 4.5 只扫描指定页面

确认项目确实有这些页面后执行：

```bash
npx lhkit scan /products /about --name selected-pages
```

命令行页面替换本次扫描使用的 `pages`，不修改配置文件。显式指定页面的轮次会标为“部分页面”，不会自动清理，也不作为完整轮次的历史基线。页面参数使用以 `/` 开头的路径。

## 5 使用模型 API 分析

先完成普通扫描，并在开发版文档中检查问题是否关联到了实际源码。没有映射或文件不可读时，先检查 `sourceMap` 和 `ai.sourceRoot`。

下面的 `ai` 示例均用于**替换配置中的 `ai` 字段**，保留 `build`、`serve`、`pages` 等其他字段。

### 5.1 选择模型服务

| 服务 | `provider` | 默认读取的 Key 环境变量 |
|---|---|---|
| Claude API | `anthropic` | `ANTHROPIC_API_KEY` |
| OpenAI API | `openai` | `OPENAI_API_KEY` |
| DeepSeek API | `deepseek` | `DEEPSEEK_API_KEY` |
| OpenAI 兼容服务或企业网关 | `openai-compatible` | `OPENAI_API_KEY`，可用 `apiKeyEnv` 修改 |

只选择一个 provider。`model` 可指定该服务实际支持、且你有权限使用的模型；不填写时使用工具内置默认值，见 [README 的模型表](../README.md#通过模型-api-分析)。

例如选择 DeepSeek：

```js
ai: {
  enabled: true,
  provider: 'deepseek',
  sourceRoot: 'src',
},
```

在执行 lhkit 的同一个终端中设置 Key：

```bash
export DEEPSEEK_API_KEY='替换为你的真实 API Key'
```

选择 OpenAI 或 Claude 时，分别设置 `OPENAI_API_KEY` 或 `ANTHROPIC_API_KEY`。lhkit 不会自动加载 `.env`；需要由当前终端或你使用的环境管理工具将变量注入进程。

### 5.2 先检查发送范围

对已有轮次试运行 AI 分析，不必重新扫描：

```bash
npx lhkit analyze first-review --ai-dry-run
```

查看终端列出的源文件和字符数。这个命令会重新分析并生成文档，但不调用模型 API、不写 AI 缓存。

默认最多分析 10 个有可用源码的问题，每文件最多 8000 字符、每问题最多 24000 字符。没有可用源码时不会为了凑数量给模型发送无关文件。

### 5.3 执行 AI 分析

```bash
# 对已有扫描结果补充 AI 建议，不重新跑 Lighthouse
npx lhkit analyze first-review
```

或者新建一轮完整扫描并分析：

```bash
npx lhkit run --name api-review
```

成功后重新打开报告：

```bash
npx lhkit preview first-review
```

如果刚执行的是 `api-review`，把 `preview` 的轮次名也改为 `api-review`。`analyze` 只处理已有扫描数据；修改了业务代码或构建产物后，需要重新 `run` 或 `scan`，才能测量修改效果。

### 5.4 接入企业网关或兼容服务

```js
ai: {
  enabled: true,
  provider: 'openai-compatible',
  baseURL: 'https://gateway.example.com/v1',
  model: '替换为网关提供的模型名',
  apiKeyEnv: 'LHKIT_API_KEY',
  responseFormat: 'json',
  sourceRoot: 'src',
},
```

```bash
export LHKIT_API_KEY='替换为网关 Key'
npx lhkit analyze first-review
```

`baseURL` 是 API 根地址，工具会追加 `/chat/completions`，不要把完整接口路径填进去。保留网关要求的 `/v1` 等前缀；地址中不能包含账户密码、查询参数或 fragment。网关不接受格式约束参数时，改用 `responseFormat: 'text'`，回答仍需符合 JSON 结构和引用校验。

不要求鉴权的本地兼容服务也需设置一个非空占位 Key。Anthropic 可配置 `baseURL`，或复用 `ANTHROPIC_BASE_URL` 环境变量，显式配置优先。

## 6 在 Codex 或 Claude Code 中使用 skill

### 6.1 安装 skill

先完成第 2 节的 CLI 安装，再在同一个业务项目中执行你使用的助手对应的命令。

Codex 项目级安装：

```bash
mkdir -p .agents/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .agents/skills/
```

Claude Code 项目级安装：

```bash
mkdir -p .claude/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .claude/skills/
```

项目目录分别由 [Codex](https://developers.openai.com/codex/skills/) 和 [Claude Code](https://code.claude.com/docs/en/skills) 的 skill 发现规则加载。把相应 skill 目录提交到业务项目，可以与团队共享。复制安装的 skill 后续需随 CLI 更新而手动更新。

也可以通过 GitHub 安装，按提示选择助手：

```bash
npx skills add wkylin/lighthouse-kit --skill lighthouse-kit
```

该安装器要求 Node ≥22.20。默认安装到当前项目，添加 `-g` 则安装到用户目录；需要固定版本时可使用已推送的 Git tag，例如 `wkylin/lighthouse-kit@v0.2.1`。[安装器说明](https://github.com/vercel-labs/skills)

### 6.2 保持 API 模式关闭

在 lhkit 配置中保留：

```js
ai: {
  enabled: false,
  sourceRoot: 'src',
},
```

显式的任务导出不受 `ai.enabled` 影响。skill 会使用当前会话的模型，不需要在配置中写 `provider: 'codex'`；这个 provider 值也不受支持。

### 6.3 向助手下达任务

在 Codex 的聊天输入框中输入：

```text
用 $lighthouse-kit 分析当前项目。
配置目录是项目根目录，先扫描首页。
使用当前会话模型，根据实际证据给出优化建议，并写回开发版和负责人版报告。
区分实测事实、静态推断和待确认项，不要直接修改业务代码。
```

Claude Code 中输入：

```text
/lighthouse-kit 使用项目根目录配置扫描首页，用当前会话分析并写回报告。
```

已有报告时可以直接说：

```text
用 $lighthouse-kit 分析已有轮次 first-review，配置目录为项目根目录。
不重新构建、不重新扫描；读取导出的任务，按证据给出建议并导入报告。
```

这些是助手里的指令，不是终端 shell 命令。若 skill 没有出现，确认目录内有 `SKILL.md`，重新打开项目会话；Codex 更新未显示时可重启客户端。[Codex skill 加载说明](https://developers.openai.com/codex/skills/)

DeepSeek 可通过支持 Agent Skills、文件和终端能力的宿主加载同一份 skill；使用 DeepSeek API 自动分析则按第 5 节操作。

### 6.4 手动完成导出和导入

需要自己控制每一步时：

```bash
# 需要新扫描时执行；下面以 session-review 为例
LHKIT_NO_OPEN=1 npx lhkit run --name session-review --ai-dry-run

# 对该轮次导出任务
npx lhkit ai-export session-review
```

如果复用已有的 `first-review`，跳过扫描，并把本节后续命令中的 `session-review` 全部替换为 `first-review`。

读取终端指向的任务文件，默认是：

```text
.lhkit/runs/session-review/ai/request.json
```

让助手按任务中的 `system`、`adviceSchema` 和实际源码生成回答，保存为 `reply.json`。格式如下，示例值必须替换为该批任务的真实内容：

```json
{
  "version": 1,
  "requestId": "从本次 request.json 原样复制",
  "roundId": "从本次 request.json 原样复制",
  "model": "实际模型名或 codex-session",
  "findings": [
    {
      "id": "从任务中复制对应审计项 ID",
      "cause": "说明实测证据、代码推断和待确认项",
      "fix": "针对证据的修改方式和适用前提",
      "confidence": "medium",
      "evidence": [
        { "file": "该任务中的源文件路径", "quote": "实际片段中逐字存在的代码" }
      ],
      "verification": ["验证诊断、修改效果和功能回归的具体步骤"]
    }
  ]
}
```

可以只回答部分任务。引用为空时，只能使用 `confidence: 'low'`，并说明缺口和确认方法；每条回答都必须有验证步骤。

导入并查看：

```bash
npx lhkit ai-import ./reply.json session-review
npx lhkit preview session-review
```

导入会校验轮次、请求 ID、审计项、引用和当前源码，校验通过后更新分析、文档和总览，不再调用模型 API。源码或影响任务内容的配置变化后需要重新导出、重新分析，不能修改请求 ID 绕过校验。

`reply.json` 相对终端的当前工作目录解析；`--config` 指定的是配置目录，两者不要混淆。使用自定义 `outDir` 时，以 CLI 输出路径为准。

## 7 阅读报告并确认优化方案

默认输出结构：

```text
.lhkit/
  runs/first-review/
    index.html                 总览
    analysis.json              分析数据
    pages/...                  各页 Lighthouse 报告
    docs/dev.md                开发版 Markdown
    docs/dev.html              开发版 HTML
    docs/lead.md               负责人版 Markdown
    docs/lead.html             负责人版 HTML
    logs/scan.log              完整扫描输出
    logs/build.log             执行构建时的日志
    logs/serve.log             使用项目服务命令时的日志
    ai/request.json            执行 ai-export 后生成
  history/                     轮次汇总
  ai-cache/                    API 分析的有效建议缓存
```

不是每轮都会生成所有日志、任务和缓存。配置了 `outDir` 时，以上结构位于该目录内。

按下面的顺序阅读：

1. 在总览检查成功/失败页面、最终 URL、跳转和加载超时，确认扫描到了预期页面。
2. 在开发版文档查看优先级靠前的问题、耗时/字节证据、源码映射和规则建议。
3. 有 AI 建议时，核对原因、改法、源码引用、证据充分程度和验证步骤。
4. 对影响较大的修改先确认调用路径和业务前提，再实施、复测并检查功能回归。

`high`、`medium`、`low` 表示模型给出的证据充分程度，不是准确率。工具验证引用确实存在于给出的片段中，但引用存在不等于因果已经证明。Lighthouse 的“估算收益”也不是修改后实际测得的改善。

“沿用此前建议，本次未重新核验”表示这次分析没有得到新的有效建议。不要把它当作对当前源码的新验证。负责人版继续使用真实扫描指标，AI 不会替换分数或制造新测量值。

## 8 调整分析范围与效率

先使用默认值，遇到具体限制时再调整。下面是配置对象中的可选 `ai` 字段示例：

```js
ai: {
  enabled: true,
  provider: 'deepseek',
  sourceRoot: 'src',
  maxFindings: 5,
  concurrency: 2,
  cache: true,
  instructions: '保持现有交互，优先分析首屏性能；先说明需要确认的调用路径。',
},
```

| 配置 | 默认值 | 什么时候调整 |
|---|---|---|
| `sourceRoot` | 有 `src/` 时为 `src/`，否则项目根目录 | 源码实际位于其他目录时，填写真实目录 |
| `exclude` | 内置排除名单 | 增加项目私有目录，例如 `['**/private/**']` |
| `maxFindings` | `10` | 先解决少量高优先级问题时可调小 |
| `maxFileChars` | `8000` | 长文件关键上下文被截断时可调大 |
| `maxFindingChars` | `24000` | 一个问题需要结合多个文件时可调大；不得小于 `maxFileChars` |
| `concurrency` | `2`，允许 1–8 | 服务限流时调小；服务允许更高并发时再调大 |
| `cache` | `true` | 对相同输入要求重新请求模型时设为 `false` |
| `timeoutMs` | `120000` | 单次请求需更长时间时调整，包含完整响应正文 |
| `maxRetries` | `1`，允许 0–3 | 不希望重试时设为 0；鉴权错误不重试 |
| `maxTokens` | `16000` | 输出被截断时调整，推理模型也可能消耗推理 token |
| `language` | `zh-CN` | 需要其他语言的 AI 建议时修改；报告固定栏目仍为中文 |
| `instructions` | 空字符串 | 补充业务限制、兼容要求和优化优先级 |
| `responseFormat` | `auto` | 网关不支持默认格式约束时改为 `json` 或 `text` |

缓存按模型、实际网关、提示、证据和源码内容匹配；相关输入变化后重新请求。缓存命中不会记为本次发送。`cache: false` 只影响 API 请求缓存，不会让失败的请求自动变成有效建议。

环境文件、凭据、密钥、依赖、锁文件、配置中的构建产物和结果目录始终排除。符号链接实际目标也检查范围与排除规则；自定义 `exclude` 只能追加，不能取消内置排除。

日常改动时优先复用已有扫描做分析；需要测量代码修改时再扫描。正式比较可用 `--runs 3` 减少单次测量波动；次数增加会增加扫描工作量。

## 9 比较优化前后

先在修改前的代码和构建下扫描，再修改业务代码，完成相同流程：

```bash
npx lhkit run --runs 3 --name before-001

# 在业务项目中完成优化后
npx lhkit run --runs 3 --name after-001

npx lhkit compare before-001 after-001
```

按终端输出打开对比文件。两轮使用相同页面、目标地址、访问方式、设备、Lighthouse 大版本和扫描次数；尽量保持机器负载与网络条件一致。对比页提示不可直接比较时，先确认差异来源。

仅执行 `analyze` 不会重新测量页面。只有重新 `run` 或 `scan` 得到的新结果，才能用于验证代码优化后的实际表现。

## 10 常见问题

| 现象 | 操作 |
|---|---|
| pnpm 报 `ERR_PNPM_ADDING_TO_ROOT` | 确认应用是否位于 workspace 根目录；安装到根目录用 `pnpm add -Dw lighthouse-kit@0.2.1`，安装到子包则进入子包目录或指定 `--filter` |
| npm 报 `EOVERRIDE` | 检查业务项目已有的直接依赖与 `overrides` 是否冲突；先按项目声明的包管理器安装。如确需使用 npm，直接依赖与对应 override 的版本声明必须完全一致，也可使用 `$依赖名` 引用直接依赖的声明 |
| 找不到配置 | 在业务项目根目录运行，或用 `--config` 指向配置所在目录 |
| 配置已存在，`init` 报错 | 编辑已有配置；确认要覆盖时才用 `init --force` |
| 找不到 Chrome | 安装 Chrome/Chromium，或用 `chromePath`、`CHROME_PATH` 指定实际可执行文件 |
| 静态目录不存在 | 先执行项目构建或 `lhkit build`；`scan` 不构建，完整流程使用 `run` |
| 端口占用或服务未就绪 | 选空闲端口，检查服务命令和 `serve.url` 是否一致；复用已有服务改用网址模式 |
| 扫描到了登录页 | 查看最终 URL，使用项目需要的 `beforePage` 准备登录态后重扫，不能把登录页分数当作业务页分数 |
| 页面加载超时 | 查看页面报告和扫描日志，结果可能不完整；先排查服务、接口、资源和页面运行错误 |
| AI 没有 Key | 在运行命令的同一终端导出 `apiKeyEnv` 指定的环境变量；`.env` 文件不会被自动加载 |
| API 401/403 | 检查 Key、模型权限和网关；修正后对原轮次重新 `analyze` |
| 模型回答被截断或无效 | 查看错误，按服务能力调整模型、`maxTokens`、`responseFormat`；本次保留规则建议 |
| AI 没建议或导出的 tasks 为空 | 检查源码映射、文件是否存在、`sourceRoot` 和排除规则；依赖、构建产物不会作为允许源码发送 |
| 回答的请求 ID 不匹配或源码已变化 | 对正确轮次重新 `ai-export`，让助手基于新任务重做回答 |
| 引用不在片段中 | 按导出任务里的文件、代码和空白字符修正引用；不能从未提供的上下文补猜 |
| 导入提示锁被占用 | 等待其他导入结束；如果进程已异常退出，确认没有导入进程后再处理错误中指出的遗留锁文件 |
| 轮次名称已存在 | 新扫描使用未使用的名称；已有结果用 `analyze` 或 `preview` |

macOS Chrome 路径示例：

```bash
export CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
```

不自动打开浏览器：

```bash
LHKIT_NO_OPEN=1 npx lhkit run --name background-review
```

出现失败时先看终端消息，再看本轮 `logs/scan.log`，构建或服务问题再看对应日志。不要只根据退出码判断所有结果是否可用。

## 11 命令速查

| 命令 | 用途 |
|---|---|
| `npx lhkit init` | 生成配置模板 |
| `npx lhkit run [页面…]` | 构建、起服务、扫描、分析、生成报告并打开总览 |
| `npx lhkit build` | 按配置执行构建 |
| `npx lhkit scan [页面…]` | 起服务并扫描，自动分析和生成报告，不自动打开总览 |
| `npx lhkit analyze [轮次]` | 使用已有扫描数据重新分析、生成报告 |
| `npx lhkit preview [轮次]` | 打开总览 |
| `npx lhkit compare <A> <B>` | 生成两轮对比 |
| `npx lhkit ai-export [轮次]` | 导出模型中立的会话任务，不调用 API |
| `npx lhkit ai-import <回答文件> [轮次]` | 校验并合入会话建议，更新报告 |

`analyze`、`preview`、`ai-export`、`ai-import` 省略轮次时选择最近一轮已结束的结果，可能包含部分页面失败；多轮并行工作时显式指定轮次。所有命令都支持 `--config <目录>`。

| 参数 | 支持的命令 |
|---|---|
| `--runs N`、`--name X`、`--url U` | `run`、`scan` |
| `--ai-dry-run` | `run`、`scan`、`analyze` |
| `--force` | `init` |

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | 运行失败、被中断，或所有页面扫描失败 |
| `2` | 配置、命令参数或 AI 回答校验错误 |
| `3` | 端口无法使用或服务未就绪 |
| `4` | 部分页面失败，成功页面仍有报告 |

完整配置类型见 [types/index.d.ts](../types/index.d.ts)，助手执行规范见 [lighthouse-kit skill](../skills/lighthouse-kit/SKILL.md)。
