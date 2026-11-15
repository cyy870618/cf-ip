#!/usr/bin/env node
/**
 * 聚合三网 Cloudflare 优选 IP，生成 public/data/nodes.json
 *
 * 数据源：
 *   1. vps789 公开优选接口 —— 每个 IP 带电信/联通/移动三网实测延迟、丢包、评分
 *   2. ymyuuu/IPDB bestcf 精选列表 —— 无测速数据，仅作为补充池（标记为未测速）
 *
 * 用法：
 *   node scripts/update-nodes.mjs            正常更新
 *   node scripts/update-nodes.mjs --dry      只打印统计，不写文件
 *   node scripts/update-nodes.mjs --out x.json
 *
 * 退出码：0 = 成功（或数据无变化）；1 = 全部数据源失败（保留旧数据，不覆盖）
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const UA = 'cf-ip-collector/1.0 (+https://pages.dev)';
const TIMEOUT = 20_000;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const outArg = args.indexOf('--out');
const OUT = outArg > -1 ? resolve(args[outArg + 1]) : resolve(ROOT, 'public/data/nodes.json');

/* ---------------- 工具 ---------------- */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPublicIPv4(ip) {
  const m = IPV4.exec(ip);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a >= 224) return false;
  return true;
}

/** 从任意文本里扒出干净的 IPv4（去掉 :port、#备注、空白等） */
function extractIP(raw) {
  if (typeof raw !== 'string') return null;
  const first = raw.trim().split(/[\s,;|]/)[0];
  const bare = first.split('#')[0].trim();
  const noPort = bare.replace(/:\d{1,5}$/, '');
  return isPublicIPv4(noPort) ? noPort : null;
}

function num(v) {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchText(url, { as = 'text' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json,*/*' : '*/*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return as === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 数据源 1：vps789 三网优选 ---------------- */

const VPS789_URL = 'https://vps789.com/public/sum/cfIpApi';

function parseVps789(json) {
  const data = (json && json.data) || {};
  /** @type {Map<string, any>} */
  const nodes = new Map();

  const readCarrier = (item, prefix) => ({
    latency: num(item[`${prefix}LatencyAvg`]),
    loss: num(item[`${prefix}PkgLostRateAvg`]),
    score: num(item[`${prefix}Score`]),
  });

  for (const group of Object.keys(data)) {
    if (!Array.isArray(data[group])) continue;
    for (const item of data[group]) {
      const ip = extractIP(item && item.ip);
      if (!ip) continue;
      const existing = nodes.get(ip) || { ip };
      // 各分组里同一 IP 的数据完全一致，取并集即可
      const telecom = readCarrier(item, 'dx');
      const unicom = readCarrier(item, 'lt');
      const mobile = readCarrier(item, 'yd');
      if (telecom.latency !== null) existing.telecom = telecom;
      if (unicom.latency !== null) existing.unicom = unicom;
      if (mobile.latency !== null) existing.mobile = mobile;
      existing.avgScore = num(item.avgScore);
      nodes.set(ip, existing);
    }
  }

  return [...nodes.values()];
}

/* ---------------- 数据源 2：IPDB 精选列表（补充，无测速） ---------------- */

const IPDB_URL = 'https://raw.githubusercontent.com/ymyuuu/IPDB/main/bestcf.txt';

function parseIPList(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const ip = extractIP(line);
    if (ip) out.push({ ip, unmeasured: true });
  }
  return out;
}

/* ---------------- 汇总排序 ---------------- */

const CAP = { all: 16, telecom: 10, unicom: 10, mobile: 10 };

function avgOf(node, key) {
  const vals = ['telecom', 'unicom', 'mobile']
    .map((c) => node[c] && node[c][key])
    .filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function pick(nodes, carrier) {
  const scored = [];
  const rest = [];
  for (const n of nodes) {
    // 全部组用三网均值展示，评分用接口给的综合分
    const m = carrier === 'all'
      ? { score: n.avgScore, latency: avgOf(n, 'latency'), loss: avgOf(n, 'loss') }
      : n[carrier];
    if (m && typeof m.score === 'number') {
      scored.push({
        ip: n.ip,
        latency: typeof m.latency === 'number' ? Math.round(m.latency * 10) / 10 : null,
        loss: typeof m.loss === 'number' ? Math.round(m.loss * 100) / 100 : null,
        score: Math.round(m.score),
      });
    } else {
      rest.push({ ip: n.ip, latency: null, loss: null, score: null });
    }
  }
  scored.sort((a, b) => a.score - b.score || (a.latency ?? 9e9) - (b.latency ?? 9e9));
  const list = scored.slice(0, CAP[carrier] ?? 10);
  if (carrier === 'all') list.push(...rest.slice(0, Math.max(0, (CAP.all ?? 16) - list.length)));
  return list;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const sources = [];
  /** @type {any[]} */
  let nodes = [];

  try {
    const json = await fetchText(VPS789_URL, { as: 'json' });
    const parsed = parseVps789(json);
    sources.push({ name: 'vps789', url: VPS789_URL, ok: true, count: parsed.length });
    nodes = nodes.concat(parsed);
  } catch (err) {
    sources.push({ name: 'vps789', url: VPS789_URL, ok: false, count: 0, error: String(err.message || err) });
  }

  try {
    const text = await fetchText(IPDB_URL);
    const parsed = parseIPList(text);
    sources.push({ name: 'IPDB', url: IPDB_URL, ok: true, count: parsed.length });
    const seen = new Set(nodes.map((n) => n.ip));
    nodes = nodes.concat(parsed.filter((n) => !seen.has(n.ip)));
  } catch (err) {
    sources.push({ name: 'IPDB', url: IPDB_URL, ok: false, count: 0, error: String(err.message || err) });
  }

  const groups = {
    all: pick(nodes, 'all'),
    telecom: pick(nodes, 'telecom'),
    unicom: pick(nodes, 'unicom'),
    mobile: pick(nodes, 'mobile'),
  };

  const total = groups.all.length;
  const usable = sources.filter((s) => s.ok && s.count > 0).length;

  console.log('[sources]');
  for (const s of sources) {
    console.log(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.name} count=${s.count}${s.error ? ' — ' + s.error : ''}`);
  }
  console.log('[groups]', Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])));

  if (!usable || total < 3) {
    console.error('[abort] 可用数据源不足或节点数 < 3，保留旧数据');
    process.exit(1);
  }

  const payload = {
    updated_at: new Date().toISOString(),
    groups,
    sources,
  };

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2).slice(0, 1200));
    return;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[write] ${OUT} (${total} nodes)`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
