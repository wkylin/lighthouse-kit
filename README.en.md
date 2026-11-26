# lighthouse-kit (lhkit)

[简体中文](README.md) | **English**

| [Installation](#installation) | [Configuration](#configuration) | [Options](#options) | [Rules](#rules) |
| :---: | :---: | :---: | :---: |

Configure your project once, then **build → start a server → scan pages with Lighthouse → analyze findings with rules and optional AI → generate reports**. Works with React, Vue, and other frontend projects that can be built or reached at a URL.

- Scan performance, accessibility, best practices, SEO, and Agentic Browsing. Get an HTML overview, original Lighthouse reports, and developer and lead reports in Markdown / HTML.
- Use a manifest and source maps to link resources to source files, merge findings across pages, and prioritize work.
- Connect Claude, OpenAI, DeepSeek, or a compatible API, or use a skill to reuse your current Codex or Claude Code session.

See the [user guide (Chinese)](docs/user-guide.md) for detailed steps and troubleshooting, [types/index.d.ts](types/index.d.ts) for configuration types, and [docs/design.md](docs/design.md) for the implementation design.

## Installation

Requires **Node.js ≥ 22.19, macOS or Linux, and Chrome / Chromium**. The browser is detected automatically; override it with the `CHROME_PATH` environment variable or the `chromePath` setting.

### CLI: run your first scan

Install in the application project using its existing package manager:

```bash
npm install -D lighthouse-kit
# For pnpm: pnpm add -D lighthouse-kit
# For Yarn: yarn add -D lighthouse-kit

npx lhkit init
# Edit lhkit.config.mjs: set the build command, server, and pages below
npx lhkit run
```

At a pnpm workspace **root**, use `pnpm add -Dw lighthouse-kit`. For a workspace package, enter its directory or use `--filter`. Run subsequent commands with `pnpm exec lhkit run` or `yarn lhkit run` as appropriate. Resolve existing npm overrides conflicts in the application's dependency declarations before installing.

To run without a project dependency, use `npx lighthouse-kit init` and `npx lighthouse-kit run`. You can also add `"perf": "lhkit run"` and `"perf:scan": "lhkit scan"` to your package scripts.

### Skill: analyze with your current assistant

Install the CLI and skill separately. After installing the CLI in the target project, copy the skill to the directory used by your assistant:

```bash
# Codex: project skill
mkdir -p .agents/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .agents/skills/

# Claude Code: project skill
mkdir -p .claude/skills
cp -R node_modules/lighthouse-kit/skills/lighthouse-kit .claude/skills/
```

Then invoke it **in the assistant chat**:

- Codex: `Use $lighthouse-kit to analyze this project`.
- Claude Code: `/lighthouse-kit`, with the target project and pages.
- A host using DeepSeek or another model: load the same [SKILL.md](skills/lighthouse-kit/SKILL.md). The host needs Agent Skills support, file access, and command execution. With a chat-only interface, use the manual export / import workflow below.

Personal skill directories are `~/.agents/skills/` and `~/.claude/skills/`, respectively. Session mode can keep `ai.enabled: false` and needs no separate API key for the CLI.

<details>
<summary>Local development links and npm publishing (maintainers)</summary>

Run `npm link` in the tool repository, then `npm link lighthouse-kit` in the application project. With pnpm, use `pnpm add -D link:/path/to/lighthouse-kit` in the application. To unlink, run `npm unlink lighthouse-kit` in the application and `npm unlink -g lighthouse-kit` for the global link. With pnpm, use `pnpm remove lighthouse-kit`, then install the desired version.

Inspect the package before publishing:

```bash
npm pack --dry-run
npm login
npm version patch
npm publish
git push --follow-tags
```

`npm publish` runs unit tests through `prepublishOnly`. The npm package includes the CLI, source, types, skill, READMEs, and license. After installing the npm package, place the skill in the assistant's discovery directory.

</details>

## Configuration

The CLI checks only the current directory for `lhkit.config.mjs`, then `lhkit.config.js`. Choose a server mode first, then add source mapping and AI as needed.

### Build and scan a local project

This example is for **Vite**, with a `build` script that runs `vite build`. For other build tools, use their build and source map options.

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

The `@type` annotation provides editor hints when the dependency is installed in the project. You can also use the exported `defineConfig({...})` helper. Source maps and the manifest should come from **the same build being scanned**.

| Server mode | Example `serve` value | Use case |
| --- | --- | --- |
| Built-in static server | `{ static: 'dist', port: 4173 }` | Built SPAs and other static projects |
| Project server command | `{ command: 'npm run preview', url: 'http://localhost:4173' }` | Custom preview servers or SSR |
| Existing URL | `{ url: 'https://staging.example.com' }` | Running local services or staging sites; skips building and starting a server |

When starting a server, the tool attempts to terminate the process occupying its port. Choose a free port. To reuse a running service, use URL mode. The built-in static server and HTTPS front proxy bind only to `127.0.0.1`.

For deployments under a subpath, include the actual prefix in `serve.url`, such as `http://localhost:4173/app/`, and verify that the server serves assets at that prefix. The built-in static server does not automatically mount build assets under arbitrary prefixes.

### Select a project directory with `--config`

```bash
npx lhkit init --config ./apps/web
npx lhkit run --config ./apps/web
npx lhkit scan /about --config /path/to/your-project
```

All commands accept `--config`. Its value is an **existing directory, not a configuration file path**. Relative directories resolve from the current working directory. The selected directory becomes the project root for configuration discovery, build and server commands, relative configuration paths, and the default `.lhkit/` output.

### Analyze through a model API

Add or replace the `ai` field in your configuration. Here is a complete standalone example:

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
    language: 'en',
    instructions: 'Preserve existing behavior and prioritize findings affecting initial load.',
  },
}
```

```bash
export DEEPSEEK_API_KEY='your-key'
npx lhkit scan --ai-dry-run   # Inspect the evidence and snippets without an API request
npx lhkit scan                # Scan an existing build and call the API
# To analyze an existing round: npx lhkit analyze <round>
```

Keys are read from the process environment; the tool does not load `.env` automatically. This example requires an existing `dist`. To build first, add `build` to the configuration and use `run`.

| `ai.provider` | Default model | Default key environment variable | Default API base URL |
| --- | --- | --- | --- |
| `anthropic` (default) | `claude-opus-5-5` | `ANTHROPIC_API_KEY` | Anthropic SDK default; override with `ANTHROPIC_BASE_URL` |
| `openai` | `gpt-4.1-mini` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |
| `deepseek` | `deepseek-flash` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| `openai-compatible` | `model` required | `OPENAI_API_KEY` | `baseURL` required |

These are the tool's built-in defaults; customize them with `model`. OpenAI, DeepSeek, and compatible services use Chat Completions. Use the skill for a Codex session.

<details>
<summary>Gateway and local compatible service example</summary>

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
    language: 'en',
  },
}
```

Set `LHKIT_API_KEY`, then scan. Even an unauthenticated local endpoint requires a nonempty placeholder key. `baseURL` preserves path prefixes such as `/v1` and must not contain credentials, query parameters, or fragments. An explicit Anthropic `baseURL` takes precedence over the environment variable. If a gateway rejects format parameters, set `responseFormat: 'text'`; the reply must still be JSON matching the schema.

</details>

## Options

### Commands and flags

Replace `npx lhkit` with `pnpm exec lhkit` or `yarn lhkit` as appropriate.

| Command | Purpose |
| --- | --- |
| `npx lhkit init` | Generate a configuration template |
| `npx lhkit run [pages…]` | Build, serve, scan, analyze, generate reports, and open the overview |
| `npx lhkit build` | Build only |
| `npx lhkit scan [pages…]` | Skip building; serve, scan, analyze, and generate reports |
| `npx lhkit analyze [round]` | Reanalyze a round and regenerate reports; may call an enabled model API |
| `npx lhkit preview [round]` | Open the overview |
| `npx lhkit compare <A> <B>` | Generate a comparison of two rounds |
| `npx lhkit ai-export [round]` | Export session analysis tasks without calling an API |
| `npx lhkit ai-import <reply-file> [round]` | Validate and import session advice without rescanning or calling an API |

| Flag | Supported commands | Meaning |
| --- | --- | --- |
| `--config DIR` | All commands | Project directory containing the configuration |
| `--runs N` | `run`, `scan` | Scans per page, selecting the median; positive integer |
| `--name NAME` | `run`, `scan` | Name a round to preserve it from automatic cleanup; choose an unused name |
| `--url URL` | `run`, `scan` | Temporarily use URL mode; skips building even with `run` |
| `--ai-dry-run` | `run`, `scan`, `analyze` | Preview enabled API analysis tasks without requests or AI cache writes |
| `--force` | `init` | Overwrite existing configuration |
| `--help` / `--version` | Top-level invocation | `npx lhkit --help` / `npx lhkit --version` |

Page arguments must start with `/`. They replace the configured page selection and mark the round as partial. Round names must start with a letter or digit and contain only letters, digits, `.`, `_`, or `-`. Unsupported flags cause a configuration error.

### Common configuration options

| Setting | Default | Purpose |
| --- | --- | --- |
| `build.command` / `build.env` | No build / `{}` | Build command and extra environment variables; ignored in URL mode |
| `pages` | Required | Nonempty page path array; paths that share an output directory are rejected |
| `serve.port` / `serve.proxy` | `4173` / `{}` | Static server port and API prefix proxy, including WebSocket support |
| `serve.readyPath` / `serve.timeoutMs` | `'/'` / `60000` | Server readiness path and timeout in milliseconds |
| `runs` / `visit` | `1` / `'first'` | Repeat scans and select the median; `'repeat'` warms the page first |
| `formFactor` | `'mobile'` | Only the mobile configuration is currently supported |
| `categories` | All five categories | `performance`, `accessibility`, `best-practices`, `seo`, `agentic-browsing` |
| `beforePage` | None | `async ({ page, url, warmup }) => {}` to prepare login or page state |
| `sourceMap.manifest` / `sourceMap.maps` | Unset | Manifest file and source map directory |
| `docs.audiences` | `['dev', 'lead']` | Developer and lead reports |
| `outDir` / `keep` | `'.lhkit'` / `'latest'` | Output directory and retention of unnamed full rounds; `keep` also accepts a positive integer |
| `chromePath` | Auto-detected | Chrome / Chromium executable path |
| `https.enabled` / `https.port` | `false` / `4443` | Local HTTP/2 front proxy with a self-signed certificate; ignored in URL mode |

### AI configuration options

`ai.enabled` defaults to `false`. Start with `provider`, `sourceRoot`, and `instructions`; most other defaults can stay as they are.

| `ai` field | Default | Purpose |
| --- | --- | --- |
| `provider` / `model` / `baseURL` / `apiKeyEnv` | See provider table | Model service, model, gateway, and key environment variable |
| `sourceRoot` | `src/` if present, otherwise project root | Limit the source files that can be provided |
| `exclude` | Built-in exclusions | Append globs; relative patterns use the project root, absolute patterns match absolute paths |
| `maxFindings` | `10` | Maximum source-linked findings to analyze |
| `instructions` / `language` | `''` / `'zh-CN'` | Business constraints and AI reply language; fixed report headings remain Chinese |
| `maxFileChars` / `maxFindingChars` | `8000` / `24000` | Source character budgets per file / finding; the former must not exceed the latter |
| `responseFormat` | `'auto'` | JSON schema for Anthropic/OpenAI, JSON for DeepSeek/compatible services; override with `'json-schema'`, `'json'`, or `'text'` |
| `concurrency` / `cache` | `2` / `true` | Concurrent API tasks (1–8); cache valid advice in `<outDir>/ai-cache/` |
| `timeoutMs` / `maxRetries` | `120000` / `1` | Complete request timeout in milliseconds; 0–3 retries for transient errors, none for authentication errors |
| `maxTokens` | `16000` | Reply token limit; reasoning models may include reasoning tokens |

`responseFormat: 'text'` omits format parameters but still validates JSON replies. Anthropic's `'json'` / `'text'` modes request JSON through the prompt. Cache keys include the provider, effective gateway, model, prompt, evidence, and source content; changing these inputs invalidates cached advice. Set `cache: false` to force new requests.

## Rules

### How findings are selected and prioritized

1. Extract findings from actual Lighthouse audits: include only `metricSavings`, `numeric`, or `binary` audits with a score below `0.9`. Performance audits in the `metrics` and `hidden` groups are excluded from optimization findings.
2. Merge findings by audit ID across pages. Performance findings come first, sorted by their summed impact across pages, then by the representative page's estimated bytes saved, affected page count, and audit ID. Other findings are sorted by affected page count, then ID.
3. Impact is `0.25 × LCP + 0.30 × TBT + 0.10 × FCP + 0.25 × CLS × 1000`, using Lighthouse's estimated milliseconds saved for the first three values. **This is a prioritization heuristic, not a predicted score increase or measured optimization result.**
4. The built-in [rule library](src/analyze/rules.mjs) supplies categories and advice. Unmapped audits retain Lighthouse titles and descriptions. Manifest / source map associations provide leads; verify the actual execution path.

Use `categories` to select audit categories, and `ai.sourceRoot`, `exclude`, source budgets, and `instructions` to control analysis scope and business constraints. There is currently no custom `rules` configuration field; editing built-in rules requires changing the rule library.

### How AI advice is validated

- Tasks cover prioritized findings that link to allowed source files. Each reply needs a cause, fix, confidence, source evidence, and verification steps. Evidence files and exact quotes must match the snippets provided for that task.
- Advice without quotes is allowed only at low confidence and must explain the evidence gap. Confidence describes evidence sufficiency. Valid quotes still require runtime checks to confirm the cause and benefit.
- Missing keys, failed requests, or invalid replies leave rule advice available. Reanalysis may retain historical advice when no new advice is obtained, marked as not revalidated this time.
- Environment files (`.env*`), credentials, private keys and certificates, `node_modules`, lockfiles, build outputs, and result directories are always excluded. Symlink targets undergo scope and exclusion checks too. `ai.exclude` adds exclusions.

Confirm that the page renders and its scripts and APIs work before interpreting scores. Broken asset paths or blank pages can still produce high scores. Resolve report warnings about load timeouts, console errors, and missing source mappings. Rerun with the same pages, visit mode, and device to verify improvements and functional regressions.

### Import session advice into reports

For an existing round, start with `ai-export`. If a new scan is needed, choose an unused round name:

```bash
LHKIT_NO_OPEN=1 npx lhkit run --name review-001 --ai-dry-run --config ./apps/web
npx lhkit ai-export review-001 --config ./apps/web
# Have the assistant read the reported ai/request.json and write reply.json per SKILL.md
npx lhkit ai-import ./reply.json review-001 --config ./apps/web
```

`ai-export` does not require `ai.enabled`. Replies must preserve the exported `requestId` and `roundId`, and identify the actual model or session label. Reexport after source or analysis task inputs change. If there are no tasks, check source maps, source scope, and exclusions before drawing code-level conclusions.

`ai-import` accepts partial task replies. After validating the entire reply, it updates analysis and reports in the same round without a new scan or history entry. Repeated imports do not double-count source records. Imports for a round are serialized, and failed output replacement attempts a rollback. Reply file paths resolve from the command's working directory, independently of `--config`.

### Reports, comparisons, and exit codes

Output defaults to `.lhkit/`; add it to `.gitignore`:

```text
.lhkit/
├── runs/<round>/
│   ├── index.html                  # Overview
│   ├── pages/<page>/run-N/lighthouse.* # Original JSON / HTML for each scan
│   ├── analysis.json               # Merged findings and AI advice
│   ├── docs/{dev,lead}.{md,html}    # Developer / lead reports
│   ├── ai/request.json             # Created by ai-export
│   └── logs/                       # Build, server, and scan logs
├── history/                        # Round summaries
└── ai-cache/                       # API advice cache, created as needed
```

Automatic retention applies to unnamed full rounds after every page in a new round succeeds. Named, partial, and aborted rounds are preserved. Restarting an aborted named round with the same name removes its previous directory; completed named rounds cannot be overwritten.

```bash
npx lhkit run --name before --runs 3
# Optimize application code, keeping pages, server, and configuration consistent
npx lhkit run --name after --runs 3
npx lhkit compare before after
```

Comparisons warn when the target address, Lighthouse major version, visit mode, device, or run count differs, or when a round is partial or unfinished. Set `LHKIT_NO_OPEN=1` to suppress browser opening in CI.

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Runtime failure, all pages failed, or interruption |
| `2` | Configuration, argument, or import validation error |
| `3` | Port could not be released or server was not ready |
| `4` | Some pages failed; reports for successful pages are still generated |

[Back to installation](#installation) · [Configuration](#configuration) · [Options](#options) · [简体中文](README.md)
