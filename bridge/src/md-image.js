// Markdown → PNG：用 marked 生成 HTML，再用 Edge headless 截图。
// 供桥接 /api/socialV2/md-image 与 MCP 工具 qq_send_markdown 使用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 40px 48px 56px;
  background: #ffffff; color: #1f2328;
  font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  width: var(--page-width, 1080px);
}
h1, h2, h3, h4 { line-height: 1.3; margin: 1.4em 0 .6em; font-weight: 650; }
h1 { font-size: 26px; border-bottom: 1px solid #d8dee4; padding-bottom: .35em; margin-top: 0; }
h2 { font-size: 20px; border-bottom: 1px solid #eaeef2; padding-bottom: .25em; }
h3 { font-size: 17px; }
h4 { font-size: 15px; color: #57606a; }
p { margin: .6em 0; }
ul, ol { margin: .5em 0 .8em; padding-left: 1.6em; }
li { margin: .22em 0; }
code {
  font-family: "Cascadia Code", Consolas, "Courier New", monospace;
  background: #f6f8fa; border: 1px solid #eaeef2; border-radius: 4px;
  padding: .12em .35em; font-size: 13px;
}
pre {
  background: #f6f8fa; border: 1px solid #eaeef2; border-radius: 8px;
  padding: 14px 16px; overflow: hidden; margin: .8em 0;
}
pre code { background: none; border: none; padding: 0; font-size: 12.5px; line-height: 1.5; }
blockquote {
  margin: .8em 0; padding: .2em 1em; color: #57606a;
  border-left: 3px solid #d0d7de; background: #fbfcfd;
}
table { border-collapse: collapse; margin: 1em 0 1.6em; width: 100%; font-size: 15px; }
th, td { border: 1px solid #e6e8eb; padding: 13px 18px; text-align: left; vertical-align: top; }
th { background: #f7f8fa; font-weight: 700; color: #1f2328; }
/* 两列表格（信息卡常见形态）：左列说明、右列数值加粗 */
td:first-child { color: #3d4450; }
td:nth-child(2):last-child { font-weight: 650; }
tr:nth-child(even) td:not(:nth-child(2):last-child) { background: #fcfcfd; }
hr { border: none; border-top: 1px solid #d8dee4; margin: 1.6em 0; }
strong { font-weight: 650; }
a { color: #0969da; text-decoration: none; }
.foot { margin-top: 28px; color: #8c959f; font-size: 12px; }
`;

function edgePath() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

async function runEdge(edge, fileUrl, outPng, width, height, tmpDir) {
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=2',
    `--user-data-dir=${path.join(tmpDir, 'edge-profile')}`,
    `--window-size=${width},${height}`,
    `--screenshot=${outPng}`,
    fileUrl
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(edge, args, { stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch {} ; reject(new Error('Edge 截图超时')); }, 60000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * 渲染 markdown 为 PNG。
 * @param {string} markdown 正文
 * @param {{outPath:string, width?:number, height?:number, tmpDir?:string}} opts
 */
export async function renderMarkdownToPng(markdown, opts = {}) {
  const { marked } = await import('marked');
  const width = Math.max(600, Math.min(1600, Number(opts.width) || 1080));
  // 没指定高度时按内容估算，避免截出一大段空白（也避免截断）。
  const textLen = String(markdown ?? '').length;
  const estHeight = Math.round(260 + textLen * 0.85);
  const height = Math.max(600, Math.min(16000, Number(opts.height) || estHeight));
  const outPng = String(opts.outPath || '').trim();
  if (!outPng) throw new Error('outPath 不能为空');
  const edge = edgePath();
  if (!edge) throw new Error('找不到 Edge，无法渲染');
  const tmpDir = opts.tmpDir || path.join(os.tmpdir(), 'dsh-md-render');
  fs.mkdirSync(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, `md-${Date.now()}.html`);
  const body = marked.parse(String(markdown ?? ''), { mangle: false, headerIds: false });
  const html = `<!doctype html><html><head><meta charset="utf-8">
<style>${CSS.replace('var(--page-width, 1080px)', `${width}px`)}</style>
</head><body><div class="card">${body}</div></body></html>`;
  fs.writeFileSync(htmlPath, html, 'utf8');
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  const fileUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
  try {
    await runEdge(edge, fileUrl, outPng, width, height, tmpDir);
  } catch (error) {
    // 重试一次，给 Edge 冷启动留余量
    await runEdge(edge, fileUrl, outPng, width, height, tmpDir);
  } finally {
    try { fs.unlinkSync(htmlPath); } catch {}
  }
  if (!fs.existsSync(outPng) || fs.statSync(outPng).size < 1000) {
    throw new Error('渲染失败：截图未生成');
  }
  return { file: outPng, bytes: fs.statSync(outPng).size, width, height };
}

export default { renderMarkdownToPng };
