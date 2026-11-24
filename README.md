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

项目根目录放 `lhkit.config.mjs`（`lhkit init` 可生成模板）：

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

常用参数：`--runs N`（每页次数，取中位数）、`--name X`（命名轮次，不会被自动清理）、`--url U`（临时改扫外部地址）、`--ai-dry-run`（只列出 AI 会发送的内容，不发送）。

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

配置 `ai: { enabled: true, sourceRoot: 'src' }` 并设置环境变量 `ANTHROPIC_API_KEY`。工具会把排名靠前、能对到源码的问题（默认 10 条）连同源码片段（每个文件最多 8000 字符，每条问题最多 24000 字符）发给 Claude（默认 `claude-opus-5-5`），把原因和改法写进开发版文档，并在文档末尾列出发送了哪些文件。以下文件永远不发送：`.env*`、`.npmrc`/`.netrc` 等凭据文件、私钥与证书（`.pem`、`.key`、`id_rsa` 等）、`node_modules`、锁文件、构建产物（source map 目录、静态目录）。指向源码目录之外的软链接不跟随。可用 `ai.exclude` 追加排除规则。先看会发什么：`lhkit scan --ai-dry-run`。没有 Key 或调用失败时自动使用规则建议。

## 发布到 npm（维护者）

```bash
npm login                      # 首次
npm version patch              # 或 minor / major：改版本号并打 tag
npm publish                    # 发布前会自动跑单元测试（prepublishOnly）
git push --follow-tags
```

发布的包只含 `bin/`、`src/`、`types/`、README 和 LICENSE（见 `package.json` 的 `files`）。发布前可用 `npm pack --dry-run` 查看内容。
