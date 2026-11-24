// Markdown → 独立 HTML 页面（样式与总览一致，跟随系统深浅色）。
import MarkdownIt from 'markdown-it'

const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export const PAGE_CSS = `
  :root { color-scheme: light dark; --good: #0c6d3a; --mid: #b45309; --bad: #c5221f; --line: color-mix(in srgb, currentColor 14%, transparent); --soft: color-mix(in srgb, currentColor 5%, transparent); }
  @media (prefers-color-scheme: dark) { :root { --good: #4ade80; --mid: #fbbf24; --bad: #f87171; } }
  body { margin: 0; padding: 28px 32px 56px; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; }
  main { max-width: 1100px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  h2 { font-size: 18px; margin: 32px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 24px 0 8px; }
  a { color: inherit; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }
  code { font: 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 1px 4px; border-radius: 4px; background: var(--soft); }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; margin: 6px 0 12px; }
  th, td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  th { font-size: 12px; font-weight: 600; opacity: 0.8; }
  blockquote { margin: 8px 0; padding: 6px 14px; border-left: 3px solid var(--line); background: var(--soft); }
  .good { color: var(--good); } .mid { color: var(--mid); } .bad { color: var(--bad); }
`

/**
 * @param {string} markdown
 * @param {string} title
 * @returns {string}
 */
export function markdownToHtmlPage(markdown, title) {
  const body = md.render(markdown).replace(/<table>/g, '<div class="wrap"><table>').replace(/<\/table>/g, '</table></div>')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style></head><body><main>
${body}</main></body></html>
`
}
