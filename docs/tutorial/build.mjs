// Builds the single-page interactive tutorial from the Markdown chapters.
//   node docs/tutorial/build.mjs
// Outputs:
//   docs/tutorial/index.html     – standalone document (open locally / host anywhere)
//   docs/tutorial/artifact.html  – same page as a fragment (no html/head/body) for claude.ai Artifacts
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import hljs from 'highlight.js';

const here = dirname(fileURLToPath(import.meta.url));
const researchDir = join(here, '..', 'research');

const chapterFiles = readdirSync(here).filter((f) => /^\d\d-.*\.md$/.test(f)).sort();
const researchFiles = readdirSync(researchDir).filter((f) => f.endsWith('.md')).sort();

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  const html = language ? hljs.highlight(text, { language }).value : esc(text);
  const label = language ?? (text.includes('──') || text.includes('┌') ? 'diagram' : 'text');
  return `<figure class="code" data-lang="${label}"><div class="code-bar"><span>${label}</span><button class="copy" type="button" data-copy>复制</button></div><pre><code class="hljs">${html}</code></pre></figure>`;
};
renderer.table = ({ header, rows }) => {
  const th = header.map((c) => `<th>${marked.parseInline(c.text)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${marked.parseInline(c.text)}</td>`).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
};
let currentChapter = '';
renderer.heading = ({ text, depth }) => {
  const inline = marked.parseInline(text);
  if (depth === 1) return ''; // chapter title is rendered by the shell
  const id = `${currentChapter}-${slug(text)}`;
  return `<h${depth} id="${id}">${inline}</h${depth}>`;
};
marked.use({ renderer, gfm: true });

const WIDGETS = {
  protocols: `
<div class="widget" data-widget="protocols">
  <div class="widget-head"><span class="eyebrow">交互 · 协议延迟档位</span><span class="widget-note">点一个协议，看它在延迟轴上的位置与代价</span></div>
  <div class="proto-row" role="tablist">
    <button class="proto" data-p="hls" role="tab">HLS</button>
    <button class="proto is-on" data-p="llhls" role="tab" aria-selected="true">LL-HLS</button>
    <button class="proto" data-p="flv" role="tab">HTTP-FLV</button>
    <button class="proto" data-p="whep" role="tab">WebRTC</button>
  </div>
  <div class="axis"><div class="axis-ticks"><span>0.1s</span><span>1s</span><span>10s</span><span>60s</span></div><div class="axis-bar"><div class="axis-range" id="proto-range"></div></div></div>
  <dl class="proto-facts" id="proto-facts"></dl>
</div>`,
  cost: `
<div class="widget" data-widget="cost">
  <div class="widget-head"><span class="eyebrow">交互 · 分发成本估算</span><span class="widget-note">按官方 2026-09 挂牌价估算，采购前请复核</span></div>
  <div class="cost-inputs">
    <label>并发观众 <input type="number" id="c-viewers" value="10000" min="1" step="100"></label>
    <label>时长（小时） <input type="number" id="c-hours" value="2" min="0.1" step="0.5"></label>
    <label>平均码率（Mbps） <input type="number" id="c-mbps" value="2.5" min="0.1" step="0.1"></label>
    <label>互动房间人数 <input type="number" id="c-rt" value="1000" min="0" step="100"></label>
  </div>
  <div class="table-wrap"><table class="cost-table"><thead><tr><th>线路</th><th>单价</th><th>用量</th><th>估算</th></tr></thead><tbody id="c-body"></tbody></table></div>
</div>`,
};

function renderChapter(file, idx) {
  const md = readFileSync(join(here, file), 'utf8');
  const title = md.match(/^# (.+)$/m)?.[1] ?? file;
  const num = file.slice(0, 2);
  currentChapter = `ch${num}`;
  let body = marked.parse(md.replace(/^# .+$/m, ''));
  body = body.replace(/<!-- widget:(\w+) -->/g, (_, name) => WIDGETS[name] ?? '');
  const h2s = [...body.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map((m) => ({ id: m[1], text: m[2].replace(/<[^>]+>/g, '') }));
  const cleanTitle = title.replace(/^\d\d · /, '');
  return { id: `ch${num}`, num, title: cleanTitle, body, h2s, idx };
}

function renderResearch(file, i) {
  const md = readFileSync(join(researchDir, file), 'utf8');
  const title = md.match(/^# (.+)$/m)?.[1] ?? file;
  currentChapter = `ap${i}`;
  const body = marked.parse(md.replace(/^# .+$/m, ''));
  return { id: `ap${i}`, num: String.fromCharCode(65 + i), title, body, h2s: [], idx: i };
}

const chapters = chapterFiles.map(renderChapter);
const appendices = researchFiles.map(renderResearch);

const toc = `
<nav class="toc" id="toc" aria-label="目录">
  <div class="toc-search"><input type="search" id="search" placeholder="搜索章节 / 小节…" autocomplete="off"></div>
  <ol class="toc-list">
    ${chapters.map((c) => `<li data-ch="${c.id}"><a href="#${c.id}"><span class="mono">${c.num}</span><span class="toc-title">${esc(c.title)}</span><span class="done" aria-hidden="true">✓</span></a>
      <ul>${c.h2s.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></li>`).join('')}
  </ol>
  <div class="toc-appendix"><span class="eyebrow">附录 · 调研报告</span>
    <ol class="toc-list">${appendices.map((a) => `<li data-ch="${a.id}"><a href="#${a.id}"><span class="mono">${a.num}</span><span class="toc-title">${esc(a.title.replace(/（.*$/, ''))}</span></a></li>`).join('')}</ol></div>
</nav>`;

const chapterHtml = chapters.map((c, i) => `
<section class="chapter" id="${c.id}" data-num="${c.num}">
  <header class="chapter-head">
    <span class="eyebrow">第 ${c.num} 章</span>
    <h1>${esc(c.title)}</h1>
    <label class="mark-read"><input type="checkbox" data-read="${c.id}"> 已读</label>
  </header>
  <div class="prose">${c.body}</div>
  <footer class="chapter-nav">
    ${i > 0 ? `<a class="prev" href="#${chapters[i - 1].id}">← ${chapters[i - 1].num} ${esc(chapters[i - 1].title)}</a>` : '<span></span>'}
    ${i < chapters.length - 1 ? `<a class="next" href="#${chapters[i + 1].id}">${chapters[i + 1].num} ${esc(chapters[i + 1].title)} →</a>` : `<a class="next" href="#ap0">附录 A →</a>`}
  </footer>
</section>`).join('');

const appendixHtml = appendices.map((a) => `
<section class="chapter appendix" id="${a.id}">
  <header class="chapter-head"><span class="eyebrow">附录 ${a.num} · 调研报告（2026-09-13）</span><h1>${esc(a.title)}</h1></header>
  <details class="prose"><summary>展开报告全文</summary>${a.body}</details>
</section>`).join('');

const css = readFileSync(join(here, 'theme.css'), 'utf8');
const js = readFileSync(join(here, 'app.js'), 'utf8');

const head = `<title>LiveLab 直播前端手册</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>${css}</style>`;

const body = `
<div class="progress" id="progress" aria-hidden="true"></div>
<header class="topbar">
  <button class="menu" id="menu" type="button" aria-controls="toc" aria-expanded="false"><span></span>目录</button>
  <a class="brand" href="#top"><span class="dot"></span>LiveLab 直播前端手册</a>
  <span class="topbar-meta mono">14 章 · 4 份调研 · 2026-09</span>
</header>
<div class="shell" id="top">
  ${toc}
  <main class="content">
    <section class="cover">
      <span class="eyebrow">直播 / 视频播放前端 · 全链路实践</span>
      <h1 class="cover-title">从推流到首帧，从弹幕到账本：<br>一份可以跑起来的直播前端手册</h1>
      <p class="lede">对应岗位要求逐项落地：直播间播放（LL-HLS / HTTP-FLV / WebRTC）、弹幕与 IM、主播互动、付费、运营工具；起播速度、卡顿率、弱网与跨境；播放质量监控、埋点与异常采集。每一章都指向仓库里真实运行的代码与可复现的实验。</p>
      <div class="cover-facts">
        <div><span class="mono big">≈0.3s</span><span>本机 LL-HLS 首帧</span></div>
        <div><span class="mono big">150ms</span><span>IM 批帧周期</span></div>
        <div><span class="mono big">5 级</span><span>卡顿恢复阶梯</span></div>
        <div><span class="mono big">275+</span><span>自动化用例</span></div>
      </div>
      <p class="cover-note">技术版本均于 2026-09-13 核实：React 19.3 · Vite 8.3 · TypeScript 5.9.3 · hls.js 1.7.3 · mpegts.js 1.8.2 · media-chrome 4.19 · Fastify 5.12 · MediaMTX 1.21.0 · ClickHouse 26.8 · Grafana 13.2。</p>
    </section>
    ${chapterHtml}
    ${appendixHtml}
    <footer class="colophon">LiveLab · 教程源文件位于 <span class="mono">docs/tutorial/*.md</span>，本页由 <span class="mono">build.mjs</span> 生成。</footer>
  </main>
</div>
<script>${js}</script>`;

const full = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
${head}
</head>
<body>${body}</body>
</html>`;

writeFileSync(join(here, 'index.html'), full);
writeFileSync(join(here, 'artifact.html'), `${head}\n${body}`);
console.log(`built ${chapters.length} chapters + ${appendices.length} appendices → index.html (${(full.length / 1024).toFixed(0)} KB)`);
