// Markdown → PNG：用 marked 生成 HTML，再用 Edge headless 截图。
// 供桥接 /api/socialV2/md-image 与 MCP 工具 qq_send_markdown 使用。
// 主题（theme）：
//   card  —— 白卡片铺在浅灰底上（信息卡观感，默认）
//   book  —— 米色纸张 + 衬线字（参考 qq-dsh-bridge/mcp-markdown-image 的 book 主题）
//   plain —— 纯白整页（导出演文档截图）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

const FONT_SANS = '-apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
const FONT_SERIF = '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif';
const FONT_MONO = '"Cascadia Code", Consolas, "Courier New", monospace';

export const THEME_NAMES = ['card', 'book', 'plain'];

const THEMES = {
  card: {
    pageBg: '#f2f3f5',
    cardBg: '#ffffff',
    cardBorder: '#eceef1',
    cardRadius: 18,
    cardShadow: '0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06)',
    outerPad: '28px',
    cardPad: '30px 34px 34px',
    font: FONT_SANS,
    baseSize: 16,
    text: '#1f2328',
    muted: '#57606a',
    border: '#e6e8eb',
    thBg: '#f7f8fa',
    codeBg: '#f6f8fa',
    blockBg: '#fbfcfd',
    accent: '#0969da',
    radius: 8,
    texture: ''
  },
  book: {
    pageBg: '#f5f0e8',
    cardBg: '#faf6ef',
    cardBorder: '#d4cbb8',
    cardRadius: 4,
    cardShadow: '0 2px 8px rgba(61,57,41,.06)',
    outerPad: '30px',
    cardPad: '22px 24px',
    font: FONT_SERIF,
    baseSize: 17,
    text: '#3d3929',
    muted: '#6b6152',
    border: '#e2dace',
    thBg: '#f0ebe0',
    codeBg: '#f0ebe0',
    blockBg: '#f7f2e9',
    accent: '#b85c38',
    radius: 4,
    texture: [
      'radial-gradient(ellipse at 20% 50%, rgba(180,160,130,.05) 0%, transparent 70%)',
      'radial-gradient(ellipse at 80% 20%, rgba(160,140,110,.04) 0%, transparent 60%)',
      'radial-gradient(ellipse at 50% 80%, rgba(140,120,90,.04) 0%, transparent 60%)'
    ].join(', ')
  },
  plain: {
    pageBg: '#ffffff',
    cardBg: '#ffffff',
    cardBorder: 'transparent',
    cardRadius: 0,
    cardShadow: 'none',
    outerPad: '24px',
    cardPad: '24px 28px',
    font: FONT_SANS,
    baseSize: 16,
    text: '#1f2329',
    muted: '#57606a',
    border: '#e8ebef',
    thBg: '#f7f8fa',
    codeBg: '#f6f7f9',
    blockBg: '#fafbfc',
    accent: '#2563eb',
    radius: 6,
    texture: ''
  }
};

function buildCss(t, width) {
  const lineH = t === THEMES.book ? 1.8 : 1.7;
  return `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: ${t.outerPad};
  background: ${t.pageBg}; color: ${t.text};
  font: ${t.baseSize}px/${lineH} ${t.font};
  width: ${width}px;
}
.card {
  background: ${t.cardBg};
  ${t.texture ? `background-image: ${t.texture};` : ''}
  border: 1px solid ${t.cardBorder};
  border-radius: ${t.cardRadius}px;
  box-shadow: ${t.cardShadow};
  padding: ${t.cardPad};
}
h1, h2, h3, h4, h5, h6 { line-height: 1.35; margin: 1.3em 0 .55em; font-weight: 600; color: ${t.text}; }
h1 { font-size: 1.55em; margin-top: 0; border-bottom: 1px solid ${t.border}; padding-bottom: .3em; }
h2 { font-size: 1.3em; border-bottom: 1px solid ${t.border}; padding-bottom: .2em; }
h3 { font-size: 1.12em; }
h4, h5, h6 { font-size: 1em; }
p { margin: .5em 0 .7em; }
ul, ol { margin: .4em 0 .8em; padding-left: 1.5em; }
li { margin: .2em 0; }
li::marker { color: ${t.muted}; }
code {
  font-family: ${FONT_MONO};
  background: ${t.codeBg}; border: 1px solid ${t.border}; border-radius: 4px;
  padding: .1em .35em; font-size: .86em;
}
pre {
  background: ${t.codeBg}; border: 1px solid ${t.border}; border-radius: ${t.radius}px;
  padding: 12px 14px; overflow: hidden; margin: .8em 0; white-space: pre-wrap;
}
pre code { background: none; border: none; padding: 0; font-size: .82em; line-height: 1.6; }
blockquote {
  margin: .8em 0; padding: .3em 1em; color: ${t.muted};
  border-left: 3px solid ${t.accent}; background: ${t.blockBg};
}
table { border-collapse: collapse; margin: .9em 0 1.3em; width: 100%; font-size: .93em; }
th, td { border: 1px solid ${t.border}; padding: 10px 14px; text-align: left; vertical-align: top; }
th { background: ${t.thBg}; font-weight: 600; color: ${t.text}; }
td:first-child { color: ${t.text}; }
td:nth-child(2):last-child { font-weight: 600; }
hr { border: none; border-top: 1px solid ${t.border}; margin: 1.4em 0; }
strong { font-weight: 650; }
a { color: ${t.accent}; text-decoration: none; }
img { max-width: 100%; }
.foot { margin-top: 24px; color: ${t.muted}; font-size: .8em; }
`;
}

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

export function normalizeTheme(name) {
  const n = String(name ?? '').trim().toLowerCase();
  return THEME_NAMES.includes(n) ? n : 'card';
}

/**
 * 渲染 markdown 为 PNG。
 * @param {string} markdown 正文
 * @param {{outPath:string, width?:number, height?:number, tmpDir?:string, theme?:string}} opts
 */
export async function renderMarkdownToPng(markdown, opts = {}) {
  const { marked } = await import('marked');
  const themeName = normalizeTheme(opts.theme);
  const theme = THEMES[themeName];
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
<style>${buildCss(theme, width)}</style>
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
  return { file: outPng, bytes: fs.statSync(outPng).size, width, height, theme: themeName };
}

export default { renderMarkdownToPng, normalizeTheme, THEME_NAMES };
