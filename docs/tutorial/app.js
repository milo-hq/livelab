(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem('livelab.handbook.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('livelab.handbook.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // --- reading progress bar
  const progress = $('#progress');
  const onScroll = () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    progress.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + '%';
  };
  document.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // --- mobile TOC drawer
  const toc = $('#toc');
  const menu = $('#menu');
  const setOpen = (open) => { toc.classList.toggle('is-open', open); menu.setAttribute('aria-expanded', String(open)); };
  menu.addEventListener('click', () => setOpen(!toc.classList.contains('is-open')));
  toc.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  // --- active chapter highlighting
  const chapters = $$('.chapter');
  const tocItems = new Map($$('.toc-list > li').map((li) => [li.dataset.ch, li]));
  if ('IntersectionObserver' in window) {
    const visible = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) visible.set(en.target.id, en.isIntersecting ? en.intersectionRatio : 0);
      let best = null, bestRatio = 0;
      for (const [id, r] of visible) if (r > bestRatio) { best = id; bestRatio = r; }
      if (!best) return;
      for (const [id, li] of tocItems) li.classList.toggle('is-active', id === best);
    }, { rootMargin: '-52px 0px -60% 0px', threshold: [0, 0.1, 0.25, 0.5] });
    chapters.forEach((c) => io.observe(c));
  }

  // --- read marks (per viewer, localStorage)
  const read = new Set(store.get('read', []));
  $$('input[data-read]').forEach((cb) => {
    cb.checked = read.has(cb.dataset.read);
    tocItems.get(cb.dataset.read)?.classList.toggle('is-read', cb.checked);
    cb.addEventListener('change', () => {
      cb.checked ? read.add(cb.dataset.read) : read.delete(cb.dataset.read);
      tocItems.get(cb.dataset.read)?.classList.toggle('is-read', cb.checked);
      store.set('read', [...read]);
    });
  });

  // --- search over TOC entries (chapters + h2)
  const search = $('#search');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    toc.classList.toggle('is-searching', q.length > 0);
    $$('.toc-list > li').forEach((li) => {
      const subs = $$('ul li', li);
      let any = false;
      subs.forEach((s) => { const hit = !q || s.textContent.toLowerCase().includes(q); s.classList.toggle('is-hidden', !hit); any = any || hit; });
      const selfHit = !q || $('a', li).textContent.toLowerCase().includes(q);
      li.classList.toggle('is-hidden', !(selfHit || any));
    });
  });

  // --- copy buttons
  $$('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const code = btn.closest('figure').querySelector('code').innerText;
      try { await navigator.clipboard.writeText(code); btn.textContent = '已复制'; } catch { btn.textContent = '不可用'; }
      setTimeout(() => { btn.textContent = '复制'; }, 1400);
    });
  });

  // --- widget: protocol latency ladder (log axis 0.1s → 60s)
  const PROTOS = {
    hls:   { name: 'HLS',        lo: 5,   hi: 45,  transport: 'HTTP 分片（TCP）', cdn: '任意 HTTP CDN', ios: '原生', cost: '最低', use: '回放式直播、大型赛事重播' },
    llhls: { name: 'LL-HLS',     lo: 2,   hi: 5,   transport: 'HTTP 分片 + Partial Segment + 阻塞式清单刷新', cdn: 'HTTP/2+，_HLS_msn/_HLS_part 进缓存键，回源合并', ios: '原生（无需 JS 播放器）', cost: '略高（请求数 ×10）', use: '直播带货、新闻、赛事' },
    flv:   { name: 'HTTP-FLV',   lo: 1,   hi: 3,   transport: 'HTTP 长连接（TCP）', cdn: '长连接透传（国内 CDN 普遍支持）', ios: '仅 iOS 17.1+ 经 ManagedMediaSource', cost: '中', use: '国内秀场 / 游戏直播桌面端' },
    whep:  { name: 'WebRTC（WHEP）', lo: 0.1, hi: 0.7, transport: 'UDP / SRTP + NACK/FEC', cdn: '需实时边缘（阿里 RTS、腾讯 LEB、Cloudflare、IVS RT）', ios: '原生 WebRTC（移动端多 100–250ms 抖动缓冲）', cost: '最高（按分钟计费）', use: '拍卖、连麦、互动竞猜' },
  };
  const protoWidget = $('[data-widget="protocols"]');
  if (protoWidget) {
    const range = $('#proto-range');
    const facts = $('#proto-facts');
    const pos = (s) => (Math.log10(s) - Math.log10(0.1)) / (Math.log10(60) - Math.log10(0.1)) * 100;
    const show = (key) => {
      const p = PROTOS[key];
      range.style.left = pos(p.lo) + '%';
      range.style.width = (pos(p.hi) - pos(p.lo)) + '%';
      facts.innerHTML = [
        ['端到端延迟', `${p.lo}–${p.hi} s`], ['传输', p.transport], ['CDN 要求', p.cdn], ['iOS Safari', p.ios], ['成本', p.cost], ['典型场景', p.use],
      ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      $$('.proto', protoWidget).forEach((b) => { const on = b.dataset.p === key; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    };
    $$('.proto', protoWidget).forEach((b) => b.addEventListener('click', () => show(b.dataset.p)));
    show('llhls');
  }

  // --- widget: cost worksheet (list prices checked 2026-09-13; see chapter 13 / appendix B)
  const costWidget = $('[data-widget="cost"]');
  if (costWidget) {
    const num = (id) => Math.max(0, Number($(id).value) || 0);
    const fmt = (n, cur) => (cur === '¥' ? '¥' : '$') + Math.round(n).toLocaleString('en-US');
    const render = () => {
      const viewers = num('#c-viewers'), hours = num('#c-hours'), mbps = num('#c-mbps'), rt = num('#c-rt');
      const gb = (viewers * hours * 3600 * mbps) / 8 / 1000; // Mbps·s → MB → GB (decimal)
      const minutes = viewers * hours * 60;
      const rows = [
        ['阿里云 视频直播 · 内地', '0.396 元/GB（0–10TB 档）', `${(gb / 1000).toFixed(1)} TB`, fmt(gb * 0.396, '¥')],
        ['阿里云 视频直播 · 亚太 1', '0.812 元/GB', `${(gb / 1000).toFixed(1)} TB`, fmt(gb * 0.812, '¥')],
        ['腾讯云 快直播 LEB · 内地', '0.52 元/GB（0–2TB 档）', `${(gb / 1000).toFixed(1)} TB`, fmt(gb * 0.52, '¥')],
        ['Cloudflare Stream', '$1 / 1000 观看分钟', `${(minutes / 1e6).toFixed(2)} M 分钟`, fmt(minutes / 1000, '$')],
        ['AWS IVS Real-Time（互动房间）', '$0.072 / 参会者小时', `${(rt * hours).toLocaleString('en-US')} 参会者小时`, fmt(rt * hours * 0.072, '$')],
      ];
      $('#c-body').innerHTML = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    };
    $$('input', costWidget).forEach((i) => i.addEventListener('input', render));
    render();
  }
})();
