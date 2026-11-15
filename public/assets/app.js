const GROUP_LABELS = { all: '全部', telecom: '电信', unicom: '联通', mobile: '移动' };

const el = {
  nodes: document.getElementById('nodes'),
  empty: document.getElementById('empty'),
  updated: document.getElementById('updated'),
  source: document.getElementById('source-line'),
  toast: document.getElementById('toast'),
  refresh: document.getElementById('refresh-btn'),
  copyGroup: document.getElementById('copy-group'),
  theme: document.getElementById('theme-btn'),
  pill: document.getElementById('live-pill'),
  pillText: document.getElementById('live-text'),
};

/* 数据被视为“延迟”的阈值：超过 95 分钟没更新就提示（CI 正常 30 分钟一跑） */
const STALE_MS = 95 * 60 * 1000;

const state = {
  data: null,
  group: 'all',
};

/* ---------------- theme ---------------- */

function initTheme() {
  const saved = localStorage.getItem('cfip-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}

el.theme.addEventListener('click', () => {
  const now = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', now);
  localStorage.setItem('cfip-theme', now);
});

/* ---------------- helpers ---------------- */

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), 1600);
}

async function copyText(text, okMsg) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toast(okMsg);
  } catch (err) {
    toast('复制失败，请手动选择文本');
  }
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚更新';
  if (min < 60) return `${min} 分钟前更新`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前更新`;
  return `${Math.floor(h / 24)} 天前更新`;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function latencyClass(v) {
  if (typeof v !== 'number') return '';
  if (v <= 120) return 'good';
  if (v >= 250) return 'bad';
  return '';
}

/* ---------------- render ---------------- */

function currentList() {
  if (!state.data || !state.data.groups) return [];
  return state.data.groups[state.group] || [];
}

function renderStats() {
  const groups = (state.data && state.data.groups) || {};
  for (const key of ['all', 'telecom', 'unicom', 'mobile']) {
    const n = (groups[key] || []).length;
    const node = document.getElementById(`stat-${key}`);
    if (node) node.textContent = n;
  }
}

function renderList() {
  const list = currentList();
  el.nodes.innerHTML = '';

  if (!list.length) {
    el.empty.hidden = false;
    return;
  }
  el.empty.hidden = true;

  const frag = document.createDocumentFragment();
  list.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'node';
    li.dataset.ip = item.ip;
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-label', `复制 ${item.ip}`);

    const meta = [];
    if (typeof item.latency === 'number') {
      meta.push(`<span class="chip chip-latency ${latencyClass(item.latency)}">${item.latency.toFixed(0)} ms</span>`);
    }
    if (typeof item.loss === 'number') {
      meta.push(`<span class="chip chip-loss">丢包 ${item.loss.toFixed(1)}%</span>`);
    }
    if (typeof item.score === 'number') {
      meta.push(`<span class="chip chip-score">评分 ${Math.round(item.score)}</span>`);
    }

    li.innerHTML = `
      <span class="node-main">
        <span class="node-ip">${item.ip}</span>
        <span class="node-meta">${meta.join('')}</span>
      </span>
      <span class="node-copy" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>
      </span>`;

    const doCopy = () => copyText(item.ip, `${item.ip} 已复制`);
    li.addEventListener('click', doCopy);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        doCopy();
      }
    });

    frag.appendChild(li);
  });

  el.nodes.appendChild(frag);
}

function renderMeta() {
  const d = state.data;
  if (!d || !d.updated_at) {
    el.updated.textContent = '数据待更新';
    return;
  }
  el.updated.textContent = `${relTime(d.updated_at)} · ${fmtTime(d.updated_at)}`;
  el.updated.title = d.updated_at;

  if (Array.isArray(d.sources) && d.sources.length) {
    const ok = d.sources.filter((s) => s.ok);
    el.source.textContent = ok.length
      ? `数据源：${ok.map((s) => s.name).join(' / ')}`
      : '数据源：暂无可用来源';
  }
}

/* ---------------- live pill ---------------- */

function renderPill(err) {
  if (err) {
    el.pill.dataset.state = 'error';
    el.pillText.textContent = '同步失败';
    el.pill.title = '节点数据加载失败';
    return;
  }
  const iso = state.data && state.data.updated_at;
  if (!iso) {
    el.pill.dataset.state = 'loading';
    el.pillText.textContent = '正在同步';
    return;
  }
  const age = Date.now() - new Date(iso).getTime();
  if (age > STALE_MS) {
    const h = Math.floor(age / 3600000);
    el.pill.dataset.state = 'stale';
    el.pillText.textContent = `数据延迟 ${h} 小时`;
    el.pill.title = `上次更新：${fmtTime(iso)}`;
  } else {
    el.pill.dataset.state = 'live';
    el.pillText.textContent = '实时更新中';
    el.pill.title = `上次更新：${fmtTime(iso)} · CI 每 30 分钟抓取一次`;
  }
}

function renderAll() {
  renderStats();
  renderList();
  renderMeta();
  renderPill(false);
}

/* ---------------- events ---------------- */

function setGroup(group) {
  state.group = group;
  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.group === group;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  renderList();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => setGroup(tab.dataset.group));
});

document.querySelectorAll('.stat').forEach((btn) => {
  btn.addEventListener('click', () => {
    setGroup(btn.dataset.jump);
    document.querySelector('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

el.copyGroup.addEventListener('click', () => {
  const list = currentList();
  if (!list.length) {
    toast('本组暂无节点');
    return;
  }
  const text = list.map((i) => i.ip).join('\n');
  copyText(text, `已复制${GROUP_LABELS[state.group]}组 ${list.length} 个 IP`);
});

/* ---------------- data loading ---------------- */

async function loadData(manual) {
  if (manual) el.refresh.classList.add('spin');
  try {
    const res = await fetch(`data/nodes.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.groups) throw new Error('数据格式异常');
    state.data = data;
    renderAll();
    if (manual) toast('已刷新');
  } catch (err) {
    el.updated.textContent = '数据加载失败';
    el.empty.hidden = false;
    el.nodes.innerHTML = '';
    el.empty.querySelector('p').textContent = '节点数据加载失败，请稍后刷新。';
    renderPill(true);
    console.error('[cf-ip]', err);
  } finally {
    if (manual) setTimeout(() => el.refresh.classList.remove('spin'), 400);
  }
}

el.refresh.addEventListener('click', () => loadData(true));

initTheme();
loadData(false);

// 每 5 分钟自动刷新一次展示（数据本身由 CI 更新）；每分钟校正一次胶囊状态
setInterval(() => {
  if (!document.hidden) loadData(false);
}, 5 * 60 * 1000);
setInterval(() => {
  if (!document.hidden && state.data) renderPill(false);
}, 60 * 1000);
