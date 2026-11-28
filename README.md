# lighthouse-kit（lhkit）

**简体中文** | [English](README.en.md)

| [安装](#安装) | [配置](#配置) | [Options](#options) | [规则](#规则) |
| :---: | :---: | :---: | :---: |

直接扫描网址，或按项目配置完成 **构建 → 启动服务 → 逐页 Lighthouse 扫描 → 规则与可选 AI 分析 → 生成报告**。适用于 React、Vue，以及其他能构建或提供访问地址的前端项目。

- 扫描性能、无障碍、最佳实践、SEO 和 Agentic Browsing，生成 HTML 总览、原始 Lighthouse 报告，以及开发版、负责人版 Markdown / HTML 文档。
- 通过 manifest 和 source map 将资源关联到源码，合并多页面问题并排序，方便确定优化顺序。
- 可直接接入 Claude、OpenAI、DeepSeek 或兼容 API，也可通过 skill 复用 Codex、Claude Code 等助手的当前会话。

完整步骤与排错见 [中文操作手册](docs/user-guide.md)；配置类型见 [types/index.d.ts](types/index.d.ts)；实现设计见 [docs/design.md](docs/design.md)。

## 安装

需要 **Node.js ≥ 22.19、macOS 或 Linux，以及 Chrome / Chromium**。浏览器默认自动查找，也可用 `CHROME_PATH` 环境变量或 `chromePath` 配置指定。

### CLI：完成第一次扫描

已有可访问的网址时，可以直接扫描，无需初始化配置或安装到项目：

```bash
npx lighthouse-kit scan --url https://example.com
npx lighthouse-kit scan --url https://example.com --max-pages 100 --max-depth 5
# 只扫描指定页面
npx lighthouse-kit scan '/about?lang=zh#intro' --url https://example.com --runs 3
```

未指定页面时，从完整入口网址、sitemap 和浏览器渲染后的站内链接自动发现页面，默认最多 50 页、链接深度 3 层，再逐页执行一次手机模式扫描和规则分析。结果写入当前目录的 `.lhkit/`，终端会输出 HTML 总览和文档路径，不会创建配置文件。`--runs 3` 可让每页多次扫描取中位数。也支持 `run --url`，会在完成后打开总览。

需要构建项目、选择多个页面或自定义登录、源码映射及 AI 时，在业务项目中安装并配置，使用该项目原有的包管理器：

```bash
npm install -D lighthouse-kit
# pnpm 项目：pnpm add -D lighthouse-kit
# Yarn 项目：yarn add -D lighthouse-kit

npx lhkit init
# 编辑生成的 lhkit.config.mjs，按下一节设置构建命令、服务和页面
npx lhkit run
```

pnpm workspace **根目录**安装使用 `pnpm add -Dw lighthouse-kit`；子包安装可进入该子包或使用 `--filter`。后续命令可对应写为 `pnpm exec lhkit run` 或 `yarn lhkit run`。若已有 npm overrides 冲突，应先处理业务项目的依赖声明。

不安装到项目也可用 `npx lighthouse-kit init`、`npx lighthouse-kit run`。项目脚本可添加 `"perf": "lhkit run"` 和 `"perf:scan": "lhkit scan"`。

### Skill：使用当前助手分析

CLI 与 skill 分别安装。先在目标项目安装 CLI，再按使用的助手选择复制位置：

```bash
# Codex：项目级 skill
mkdir -p .agents/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .agents/skills/

# Claude Code：项目级 skill
mkdir -p .claude/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .claude/skills/
```

安装后在**助手对话中**使用：

- Codex：`用 $lighthouse-kit 分析这个项目`。
- Claude Code：`/lighthouse-kit`，并说明目标项目和页面。
- 以 DeepSeek 等模型为后端、支持 Agent Skills 且能读写文件和执行命令的宿主：加载同一份 [SKILL.md](skills/lighthouse-kit/SKILL.md)。只有聊天界面时，使用下方手动导出 / 导入流程。

个人级目录分别为 `~/.agents/skills/` 和 `~/.claude/skills/`。会话模式可保持 `ai.enabled: false`，无需给 CLI 另配 API Key。

<details>
<summary>本地开发链接与 npm 发布（维护者）</summary>

在工具仓库运行 `npm link`，再到业务项目运行 `npm link lighthouse-kit`；pnpm 可在业务项目使用 `pnpm add -D link:/path/to/lighthouse-kit`。取消 npm 链接使用 `npm unlink lighthouse-kit`，工具仓库的全局链接使用 `npm unlink -g lighthouse-kit`；pnpm 使用 `pnpm remove lighthouse-kit`，再安装所需版本。

发布前检查 npm 包内容：

```bash
npm pack --dry-run
npm login
npm version patch
npm publish
git push --follow-tags
```

`npm publish` 会通过 `prepublishOnly` 执行单元测试。npm 包包含 CLI、源码、类型、skill、README 和许可证；安装 npm 包后仍需将 skill 放入助手的发现目录。

</details>

## 配置

默认只在当前目录依次查找 `lhkit.config.mjs`、`lhkit.config.js`。先选择服务方式，再按需要添加源码映射与 AI。

`run`、`scan` 同时兼容配置文件和 `--url`：找到配置时读取项目设置，`--url` 覆盖目标地址，`--runs` 和命令行页面参数覆盖对应设置；找不到配置时，提供 `--url` 即可使用默认参数。已有配置的读取或校验错误仍会报告。

无配置或配置中未写 `pages` 时，URL 的路径、查询参数和 hash 作为完整入口保留，开启自动发现；显式传入页面参数（如 `scan / /about --url https://example.com`）则只扫描该 origin 下的指定路径。有配置且设置了 `pages` 时，`--url` 继续作为配置页面的基础地址，支持 `/app/` 等部署前缀。

### 自动发现页面

省略 `pages` 即启用自动发现；命令行页面列表优先于配置列表，两种显式列表都会跳过自动发现。只扫首页可用 `scan / --url https://example.com`，或配置 `pages: ['/']`。

```js
export default {
  serve: { url: 'https://example.com' },
  // 省略 pages，自动发现页面
  crawl: { maxPages: 50, maxDepth: 3, timeoutMs: 15000 },
}
```

发现过程读取 sitemap（含索引）及渲染后的链接，支持 `#/…`、`#!/…` 路由和有意义的查询参数；去重普通锚点和末尾斜杠别名，过滤静态资源、下载链接和退出登录链接。入口发生重定向时，以最终 origin 为站点范围，后续发现不跳转到站外。`beforePage` 在发现阶段也会执行。

可用 `--max-pages`、`--max-depth` 覆盖配置上限。达到限制或遇到发现错误时，终端会提示，本轮标记为部分扫描，保留之前的完整结果。未出现在 sitemap 或可见链接中的私有路由、必须通过按钮或表单进入的页面，需要显式补充页面列表。

链接深度限制沿链接的遍历，sitemap 页面作为直接入口，仍计入页数上限。单次发现最多读取 10 份 sitemap、每份 2 MiB，以及每页 2000 条链接；触及这些边界时也会记录具体原因。

### 本地构建项目

下面是 **Vite 项目**示例；`package.json` 中的 `build` 脚本应执行 `vite build`。其他构建工具请使用对应的构建和 source map 选项。

```js
/** @type {import('lighthouse-kit').UserConfig} */
export default {
  build: { command: 'npm run build -- --sourcemap hidden --manifest' },
  serve: { static: 'dist', port: 4173 },
  pages: ['/', '/about'],
  sourceMap: { manifest: 'dist/.vite/manifest.json', maps: 'dist' },
  docs: { audiences: ['dev', 'lead'] },
  ai: { enabled: false },
}
```

`@type` 提供编辑器类型提示，项目安装依赖后可解析类型；也可使用包导出的 `defineConfig({...})`。source map 和 manifest 应来自**本次扫描对应的构建**。

| 服务方式 | `serve` 配置示例 | 使用场景 |
| --- | --- | --- |
| 工具托管静态目录 | `{ static: 'dist', port: 4173 }` | 已构建的 SPA 等静态项目 |
| 启动项目自己的服务 | `{ command: 'npm run preview', url: 'http://localhost:4173' }` | 自定义预览服务或 SSR |
| 复用已运行的地址 | `{ url: 'https://staging.example.com' }` | 本地现有服务、测试站点；跳过构建与起服务 |

启动服务时若端口被占用，工具会尝试结束占用进程。请选择空闲端口；要复用已有服务，请使用 URL 模式。工具自带的静态服务和 HTTPS 前置代理仅监听 `127.0.0.1`。

子路径部署时，`serve.url` 应包含实际前缀，例如 `http://localhost:4173/app/`，并确认服务正确返回该前缀下的资源。内置静态服务不会自动为构建产物挂载任意资源前缀。

### 使用 `--config` 指定项目目录

```bash
npx lhkit init --config ./apps/web
npx lhkit run --config ./apps/web
npx lhkit scan /about --config /path/to/your-project
```

`--config` 在所有命令中均可用，参数是**已有的目录，不是配置文件路径**。相对目录按当前工作目录解析。该目录成为项目根目录：配置查找、构建和服务命令、配置中的相对路径以及默认 `.lhkit/` 输出均以此为基准。

### 通过模型 API 分析

在现有配置中加入或替换 `ai` 字段。以下是可独立使用的示例：

```js
export default {
  serve: { static: 'dist' },
  pages: ['/'],
  sourceMap: { manifest: 'dist/.vite/manifest.json', maps: 'dist' },
  ai: {
    enabled: true,
    provider: 'deepseek',
    sourceRoot: 'src',
    exclude: ['**/private/**'],
    instructions: '保持现有功能，优先分析影响首屏加载的问题。',
  },
}
```

```bash
export DEEPSEEK_API_KEY='你的 Key'
npx lhkit scan --ai-dry-run   # 先检查将发送的证据与片段，不请求 API
npx lhkit scan                # 扫描已有构建并调用 API
# 已有轮次只需补充分析：npx lhkit analyze <轮次>
```

Key 从进程环境读取，工具不自动加载 `.env`。上例使用已存在的 `dist`；需要先构建时，在配置中添加 `build` 并执行 `run`。

| `ai.provider` | 默认模型 | 默认 Key 环境变量 | 默认 API 根地址 |
| --- | --- | --- | --- |
| `anthropic`（默认） | `claude-opus-5-5` | `ANTHROPIC_API_KEY` | Anthropic SDK 默认地址，可用 `ANTHROPIC_BASE_URL` 覆盖 |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `deepseek` | `deepseek-flash` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| `openai-compatible` | 必填 `model` | `OPENAI_API_KEY` | 必填 `baseURL` |

表中是工具内置默认值，可用 `model` 自定义。OpenAI、DeepSeek 及兼容服务使用 Chat Completions；Codex 通过 skill 使用当前会话。

<details>
<summary>企业网关与本地兼容服务示例</summary>

```js
export default {
  serve: { static: 'dist' },
  pages: ['/'],
  sourceMap: { manifest: 'dist/.vite/manifest.json', maps: 'dist' },
  ai: {
    enabled: true,
    provider: 'openai-compatible',
    baseURL: 'https://gateway.example.com/v1',
    model: 'your-model',
    apiKeyEnv: 'LHKIT_API_KEY',
    responseFormat: 'json',
  },
}
```

设置 `LHKIT_API_KEY` 后执行扫描。无需鉴权的本地服务也需要一个非空占位 Key。`baseURL` 保留 `/v1` 等路径前缀，不能包含账户密码、查询参数或 fragment；Anthropic 的显式 `baseURL` 优先于环境变量。网关不支持格式参数时可设 `responseFormat: 'text'`，回答仍须是符合 schema 的 JSON。

</details>

## Options

### 命令与参数

以下示例均可将 `npx lhkit` 换为 `pnpm exec lhkit` 或 `yarn lhkit`。

| 命令 | 作用 |
| --- | --- |
| `npx lhkit init` | 生成配置模板 |
| `npx lhkit run [页面…]` | 构建、起服务、扫描、分析、生成文档并打开总览 |
| `npx lhkit build` | 仅构建 |
| `npx lhkit scan [页面…]` | 跳过构建，起服务、扫描、分析并生成文档 |
| `npx lhkit analyze [轮次]` | 重新分析已有轮次并生成文档，可调用已启用的模型 API |
| `npx lhkit preview [轮次]` | 打开总览 |
| `npx lhkit compare <A> <B>` | 生成两轮对比文档 |
| `npx lhkit ai-export [轮次]` | 导出会话分析任务，不调用 API |
| `npx lhkit ai-import <回答文件> [轮次]` | 校验并写回会话建议，不重扫、不调用 API |

| 参数 | 支持命令 | 说明 |
| --- | --- | --- |
| `--config DIR` | 所有命令 | 指定配置所在的项目目录 |
| `--runs N` | `run`、`scan` | 每页扫描次数，取中位数，正整数 |
| `--name NAME` | `run`、`scan` | 命名轮次，免于自动清理；使用未用过的名称 |
| `--url URL` | `run`、`scan` | 覆盖目标地址；无配置时使用默认参数；跳过构建和起服务 |
| `--max-pages N` / `--max-depth N` | `run`、`scan` | 自动发现最多页面数 / 链接深度，默认 `50` / `3` |
| `--ai-dry-run` | `run`、`scan`、`analyze` | 预览已启用的 API 分析任务，不请求 API、不写 AI 缓存 |
| `--force` | `init` | 覆盖已有配置 |
| `--help` / `--version` | 顶层调用 | `npx lhkit --help` / `npx lhkit --version` |

页面参数须以 `/` 开头，传入后替换配置中的页面选择，轮次标记为部分扫描。轮次名称以字母或数字开头，只包含字母、数字、`.`、`_`、`-`。不支持的参数会报配置错误。

### 常用配置项

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `build.command` / `build.env` | 不构建 / `{}` | 项目构建命令及附加环境变量，URL 模式忽略 |
| `pages` | 自动发现 | 显式设置非空数组时只扫列表；重复结果目录会报错 |
| `crawl.maxPages` / `crawl.maxDepth` / `crawl.timeoutMs` | `50` / `3` / `15000` | 自动发现页数、链接深度与每次导航或 sitemap 请求超时（毫秒） |
| `serve.port` / `serve.proxy` | `4173` / `{}` | 静态模式端口和接口前缀代理，支持 WebSocket |
| `serve.readyPath` / `serve.timeoutMs` | `'/'` / `60000` | 服务就绪探测路径和超时（毫秒） |
| `runs` / `visit` | `1` / `'first'` | 多次取中位数；`'repeat'` 会先预热以测试回访 |
| `formFactor` | `'mobile'` | 当前仅支持移动端配置 |
| `categories` | 五类全扫 | `performance`、`accessibility`、`best-practices`、`seo`、`agentic-browsing` |
| `beforePage` | 无 | `async ({ page, url, warmup }) => {}`，准备登录态或页面状态 |
| `sourceMap.manifest` / `sourceMap.maps` | 未设置 | manifest 文件和 source map 目录 |
| `docs.audiences` | `['dev', 'lead']` | 开发版和负责人版文档 |
| `outDir` / `keep` | `'.lhkit'` / `'latest'` | 结果目录及未命名完整轮次保留策略；`keep` 也可为正整数 |
| `chromePath` | 自动查找 | Chrome / Chromium 可执行文件路径 |
| `https.enabled` / `https.port` | `false` / `4443` | 本地 HTTP/2 自签证书前置代理，URL 模式忽略 |

### AI 配置项

`ai.enabled` 默认 `false`。从 `provider`、`sourceRoot` 和 `instructions` 开始，其余通常无需修改。

| `ai` 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `provider` / `model` / `baseURL` / `apiKeyEnv` | 见服务商表 | 选择模型服务、模型、网关和 Key 环境变量 |
| `sourceRoot` | 有 `src/` 时用它，否则项目根目录 | 限定允许提供的源码范围 |
| `exclude` | 内置排除项 | 追加 glob；相对规则以项目根目录为基准，绝对规则匹配绝对路径 |
| `maxFindings` | `10` | 最多分析多少条有源码关联的问题 |
| `instructions` / `language` | `''` / `'zh-CN'` | 业务约束与 AI 回答语言；报告固定栏目仍为中文 |
| `maxFileChars` / `maxFindingChars` | `8000` / `24000` | 每文件 / 每问题的源码字符预算，前者不能大于后者 |
| `responseFormat` | `'auto'` | Anthropic/OpenAI 用 JSON schema，DeepSeek/兼容服务用 JSON；可指定 `'json-schema'`、`'json'`、`'text'` |
| `concurrency` / `cache` | `2` / `true` | API 并发数（1–8）；有效建议缓存于 `<outDir>/ai-cache/` |
| `timeoutMs` / `maxRetries` | `120000` / `1` | 单次完整请求超时（毫秒）；临时错误重试 0–3 次，鉴权错误不重试 |
| `maxTokens` | `16000` | 回答 token 上限，推理模型也可能计入推理 token |

`responseFormat: 'text'` 只是不传格式参数，仍校验 JSON 回答；Anthropic 的 `'json'` / `'text'` 通过提示要求 JSON。缓存按服务商、实际网关、模型、提示、证据和源码内容匹配，改变这些输入会失效；设 `cache: false` 可强制重新请求。

## 规则

### 问题如何筛选和排序

1. 从实际 Lighthouse 审计提取问题：只收集 `metricSavings`、`numeric`、`binary` 类型中分数小于 `0.9` 的项目；性能分类的 `metrics`、`hidden` 组不作为优化问题。
2. 按审计 ID 合并多页面问题。性能问题排在前面，按各页面影响值之和降序；相同时依次比较代表页面的节省字节数、受影响页面数、审计 ID。其他问题按受影响页面数降序，再按 ID 排序。
3. 影响值使用 `0.25 × LCP + 0.30 × TBT + 0.10 × FCP + 0.25 × CLS × 1000`，前三项取 Lighthouse 估算可节省的毫秒数。**这是工具的排序依据，不是预计提分，也不是实测优化收益。**
4. 内置 [规则库](src/analyze/rules.mjs) 提供问题分类与改法；未覆盖的审计保留 Lighthouse 标题和说明。manifest / source map 提供源码关联线索，仍需核实实际调用路径。

可用 `categories` 调整扫描分类，用 `ai.sourceRoot`、`exclude`、字符预算和 `instructions` 控制分析范围与业务约束。目前没有用户自定义 `rules` 配置字段；修改内置规则需编辑规则库。

### AI 建议如何校验

- 只为排名靠前且能关联到允许源码的问题生成任务。每条建议需包含原因、改法、置信度、源码引用与验证步骤；引用文件及逐字引用必须匹配本次提供的片段。
- 没有引用的建议只允许低置信度，并需说明证据缺口。置信度表示证据充分程度；引用有效仍需通过运行验证确认原因与收益。
- 没有 Key、请求失败或回答无效时保留规则建议；重新分析未获得新建议时，可保留历史建议并标注“本次未重新核验”。
- 始终排除 `.env*`、凭据、私钥证书、`node_modules`、锁文件、构建产物和结果目录；符号链接的实际目标同样检查范围与排除规则。`ai.exclude` 追加排除项。

先确认页面实际渲染、脚本和接口正常，再解读分数。资源路径错误或空白页也可能得到较高分；报告中的加载超时、控制台错误和源码缺失提示应一并处理。按同一页面、访问模式和设备复测，验证优化收益与功能回归。

### 会话建议写回报告

已有轮次可直接从 `ai-export` 开始。需要新扫描时，使用一个新的轮次名：

```bash
LHKIT_NO_OPEN=1 npx lhkit run --name review-001 --ai-dry-run --config ./apps/web
npx lhkit ai-export review-001 --config ./apps/web
# 助手读取命令输出指向的 ai/request.json，按 SKILL.md 格式生成 reply.json
npx lhkit ai-import ./reply.json review-001 --config ./apps/web
```

`ai-export` 无需开启 `ai.enabled`。回答需原样带回 `requestId`、`roundId`，并注明实际模型名或会话标签。源码或分析任务输入变化后需重新导出。任务为空时先检查 source map、源码范围及排除项，不能据此编造代码原因。

`ai-import` 支持部分任务回答；整批校验通过后更新原轮次分析和报告，不新增扫描或历史。重复导入不重复累计源码记录，同轮导入串行处理，产物替换失败会尝试回滚。回答文件路径按命令的当前工作目录解析，与 `--config` 分开。

### 报告、对比与退出码

默认输出到 `.lhkit/`，请加入 `.gitignore`：

```text
.lhkit/
├── runs/<轮次>/
│   ├── index.html                  # 总览
│   ├── pages/<页面>/run-N/lighthouse.* # 每次扫描的原始 JSON / HTML
│   ├── analysis.json               # 合并问题和 AI 建议
│   ├── docs/{dev,lead}.{md,html}    # 开发版 / 负责人版
│   ├── ai/request.json             # 执行 ai-export 后生成
│   └── logs/                       # 构建、服务、扫描日志
├── history/                        # 各轮次摘要
└── ai-cache/                       # API 建议缓存（按需生成）
```

默认只清理未命名的完整轮次，且在新一轮全部页面成功后清理；命名、部分扫描和中断轮次保留。重跑同名的已中断轮次会清理旧目录，已完成的命名轮次不能覆盖。

```bash
npx lhkit run --name before --runs 3
# 完成业务代码优化后，保持页面、服务与配置一致
npx lhkit run --name after --runs 3
npx lhkit compare before after
```

目标地址、Lighthouse 大版本、访问方式、设备或次数不一致，以及部分扫描或未完成轮次，都会显示对比提示。`LHKIT_NO_OPEN=1` 可关闭自动打开浏览器，适合 CI。

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 运行失败、全部页面失败或中断 |
| `2` | 配置、参数或导入校验错误 |
| `3` | 端口无法释放或服务未就绪 |
| `4` | 部分页面失败，成功页面的报告仍会生成 |

[返回安装](#安装) · [配置](#配置) · [Options](#options) · [English](README.en.md)
