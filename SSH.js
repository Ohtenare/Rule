/**
 * Egern 小组件：VPS 服务器监控 · Hark 液态玻璃统一版 v1
 * UI 与「订阅流量监控 Hark 改版」统一风格
 *
 * 功能：
 *   - SSH 直连采集 CPU / 内存 / 磁盘 / 流量 / 负载 / 运行时长
 *   - vnstat 按月流量统计（自动检测，未安装回退月差值模式）
 *   - 本地缓存：连接失败时显示上次成功数据并标注「缓存」
 *   - 本地 SVG 圆环 / 仪表 / 进度条，无外部依赖
 *   - 支持小 / 中 / 大组件与锁屏组件
 *
 * Env：
 *   SERVER_HOST（必填）  服务器 IP 或域名（IPv4/IPv6 均可）
 *   SERVER_PORT          SSH 端口，默认 22
 *   SERVER_USER          SSH 用户名，默认 root
 *   SERVER_PASSWORD      SSH 密码（与 SERVER_KEY 二选一，私钥优先）
 *   SERVER_KEY           SSH 私钥（RSA / Ed25519，支持完整格式或纯 Base64）
 *   WIDGET_NAME          显示名称，留空用服务器 hostname
 *   MASK_IP              IP 打码，默认 true（123.45.*.* / 2001:db8:****:****）
 *   TRAFFIC_LIMIT        月流量限额 GB，默认 2000
 *   RESET_DAY            流量重置日（1~31），需与 vnstat MonthRotate 一致
 *   REFRESH_MINUTES      刷新间隔（分钟，5~120），默认 15
 */

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

function storageKey(host) {
  return `egern.server.monitor.v1.${hashString(host)}`;
}

function readConfig(ctx) {
  const env = ctx.env || {};
  return {
    host: String(env.SERVER_HOST || '').trim(),
    port: Number(env.SERVER_PORT) || 22,
    username: String(env.SERVER_USER || 'root').trim() || 'root',
    password: String(env.SERVER_PASSWORD || ''),
    privateKey: String(env.SERVER_KEY || ''),
    name: String(env.WIDGET_NAME || '').trim(),
    maskIp: String(env.MASK_IP ?? 'true') !== 'false',
    trafficLimitGB: Number(env.TRAFFIC_LIMIT) || 2000,
    resetDay: Number(env.RESET_DAY) || 1,
  };
}

function normalizeKey(privateKey) {
  if (!privateKey || typeof privateKey !== 'string') return '';
  const raw = privateKey.trim();
  const headerMatch = raw.match(/-----BEGIN [A-Z ]+-----/);
  const footerMatch = raw.match(/-----END [A-Z ]+-----/);
  if (headerMatch && footerMatch) {
    const header = headerMatch[0];
    const footer = footerMatch[0];
    let body = raw.substring(raw.indexOf(header) + header.length, raw.indexOf(footer));
    body = body.replace(/\s+/g, '');
    const lines = body.match(/.{1,64}/g) || [];
    return `${header}\n${lines.join('\n')}\n${footer}`;
  }
  return raw.replace(/\\n/g, '\n');
}

function maskIP(ip, enabled) {
  if (!ip || !enabled) return ip;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  } else if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length > 2) return `${parts[0]}:${parts[1]}:****:****`;
  }
  return ip;
}

// ---------------------------------------------------------------------------
// SSH 采集
// ---------------------------------------------------------------------------

async function collect(ctx, cfg) {
  const finalKey = normalizeKey(cfg.privateKey);
  const session = await ctx.ssh.connect({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    ...(finalKey ? { privateKey: finalKey } : { password: cfg.password }),
    timeout: 8000,
  });

  const SEP = '<<SEP>>';
  const cmds = [
    'hostname -s 2>/dev/null || hostname',
    'cat /proc/loadavg',
    'cat /proc/uptime',
    'head -1 /proc/stat',
    "awk '/MemTotal/{t=$2}/MemFree/{f=$2}/Buffers/{b=$2}/^Cached/{c=$2}END{print t,f,b,c}' /proc/meminfo",
    'df -B1 / | tail -1',
    'nproc',
    "awk '/^ *(eth|en|wlan|ens|eno|bond|veth)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev",
    'vnstat --json -m 1 2>/dev/null || echo ""',
  ];
  const { stdout } = await session.exec(cmds.join(` && echo '${SEP}' && `));
  await session.close();
  return stdout.split(SEP).map(s => s.trim());
}

function parseMetrics(ctx, cfg, p, key) {
  const hostname = p[0] || 'Server';
  const load = (p[1] || '0 0 0').split(' ').slice(0, 3);

  const upSec = parseFloat((p[2] || '0').split(' ')[0]) || 0;
  const upDays = Math.floor(upSec / 86400);
  const upHours = Math.floor((upSec % 86400) / 3600);
  const upMins = Math.floor((upSec % 3600) / 60);
  const uptime = upDays > 0 ? `${upDays}天 ${upHours}小时` : `${upHours}小时 ${upMins}分`;

  // CPU：与上次采样做差值
  const cpuNums = (p[3] || '').replace(/^cpu\s+/, '').split(/\s+/).map(Number);
  const cpuTotal = cpuNums.reduce((a, b) => a + b, 0);
  const cpuIdle = cpuNums[3] || 0;
  const cpuKey = `${key}.cpu`;
  let prevCpu = null;
  try { prevCpu = ctx.storage?.getJSON(cpuKey); } catch {}
  let cpuPct = 0;
  if (prevCpu && cpuTotal > prevCpu.t) {
    cpuPct = Math.round(((cpuTotal - prevCpu.t - (cpuIdle - prevCpu.i)) / (cpuTotal - prevCpu.t)) * 100);
  }
  try { ctx.storage?.setJSON(cpuKey, { t: cpuTotal, i: cpuIdle }); } catch {}
  cpuPct = Math.max(0, Math.min(100, cpuPct));

  const memKB = (p[4] || '0 0 0 0').split(' ').map(Number);
  const memTotal = memKB[0] * 1024 || 1;
  const memUsed = memTotal - (memKB[1] * 1024 || 0) - (memKB[2] * 1024 || 0) - (memKB[3] * 1024 || 0);
  const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));

  const df = (p[5] || '').split(/\s+/);
  const diskTotal = Number(df[1]) || 1, diskUsed = Number(df[2]) || 0;
  const diskPct = parseInt(df[4]) || 0;
  const cores = parseInt(p[6]) || 1;

  const nn = (p[7] || '0 0').split(' ');
  const netRx = Number(nn[0]) || 0, netTx = Number(nn[1]) || 0;

  // 流量：优先 vnstat（按月），回退月差值模式
  let tfRx = 0, tfTx = 0, tfSource = '月差值';
  if (p[8]) {
    try {
      const vn = JSON.parse(p[8]);
      const monthArr = vn.interfaces?.[0]?.traffic?.month;
      if (monthArr && monthArr[0]) {
        tfRx = Number(monthArr[0].rx) || 0;
        tfTx = Number(monthArr[0].tx) || 0;
        tfSource = 'vnstat';
      }
    } catch {}
  }
  if (tfSource !== 'vnstat') {
    const baseKey = `${key}.netbase`;
    let base = null;
    try { base = ctx.storage?.getJSON(baseKey); } catch {}
    const now = new Date();
    const curMonth = now.getMonth();
    if (base && base.rx !== undefined) {
      const newCycle = (curMonth !== base.month) && (now.getDate() >= cfg.resetDay);
      const rebooted = (netRx < base.rx) || (netTx < base.tx);
      if (newCycle || rebooted) {
        try { ctx.storage?.setJSON(baseKey, { rx: netRx, tx: netTx, month: curMonth }); } catch {}
      } else {
        tfRx = netRx - base.rx;
        tfTx = netTx - base.tx;
      }
    } else {
      try { ctx.storage?.setJSON(baseKey, { rx: netRx, tx: netTx, month: curMonth }); } catch {}
    }
  }

  const tfUsed = tfRx + tfTx;
  const tfTotal = cfg.trafficLimitGB * (1024 ** 3);
  const tfPct = Math.min((tfUsed / tfTotal) * 100, 100) || 0;

  return {
    hostname, uptime, load, cpuPct, cores,
    memTotal, memUsed, memPct, diskTotal, diskUsed, diskPct,
    ip: maskIP(cfg.host, cfg.maskIp),
    tfRx, tfTx, tfUsed, tfTotal, tfPct, tfSource,
  };
}

// 加载 + 缓存：成功存 live，失败回退 stale，无缓存报 error
async function loadServer(ctx, cfg) {
  const key = storageKey(cfg.host);
  try {
    const p = await collect(ctx, cfg);
    const data = parseMetrics(ctx, cfg, p, key);
    const result = { mode: 'live', data, updatedAt: Date.now() };
    try { ctx.storage?.setJSON(key, result); } catch {}
    return { ...result, name: cfg.name || data.hostname };
  } catch (error) {
    const msg = String(error?.message || error || '连接失败');
    let cached = null;
    try { cached = ctx.storage?.getJSON(key); } catch {}
    if (cached?.data) {
      return { ...cached, mode: 'stale', error: msg, name: cfg.name || cached.data.hostname };
    }
    return { mode: 'error', error: msg, name: cfg.name || cfg.host, updatedAt: 0 };
  }
}

// ---------------------------------------------------------------------------
// 计算
// ---------------------------------------------------------------------------

function fmtBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes)) return '--';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / (1024 ** i);
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? Math.min(1, decimals) : decimals)} ${units[i]}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function nextReset(resetDay) {
  const day = Number(resetDay);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  const now = new Date();
  const last = (y, m) => new Date(y, m + 1, 0).getDate();
  let y = now.getFullYear(), m = now.getMonth();
  let d = Math.min(day, last(y, m));
  if (now.getDate() > d) { m += 1; if (m > 11) { m = 0; y += 1; } d = Math.min(day, last(y, m)); }
  const target = new Date(y, m, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { days: Math.max(0, Math.round((target - today) / 86400000)), date: target.getTime() };
}

function trafficColor(pct) {
  if (pct >= 85) return C.fail;
  if (pct >= 60) return C.warn;
  return C.ok;
}

function statusOf(s) {
  if (s.mode === 'error') return { label: '失败', color: C.fail };
  if (s.mode === 'stale') return { label: '缓存', color: C.warn };
  const d = s.data;
  if (d.cpuPct >= 90 || d.memPct >= 90 || d.diskPct >= 90 || d.tfPct >= 85) return { label: '偏高', color: C.warn };
  return { label: '正常', color: C.ok };
}

function refreshAt(ctx) {
  const v = Number(ctx.env?.REFRESH_MINUTES);
  const m = Number.isFinite(v) && v > 0 ? Math.min(120, Math.max(5, v)) : 15;
  return new Date(Date.now() + m * 60000).toISOString();
}

// ---------------------------------------------------------------------------
// 视觉：iOS 液态玻璃（与订阅流量监控统一）
// ---------------------------------------------------------------------------

const C = {
  text: { light: '#000000', dark: '#FFFFFF' },
  dim:  { light: '#3C3C4399', dark: '#EBEBF599' },
  glass: { light: '#FFFFFFA6', dark: '#FFFFFF1A' },
  accent: '#0A84FF',
  cpu: '#0A84FF',
  mem: '#BF5AF2',
  disk: '#FF9F0A',
  ok: '#30D158',
  warn: '#FF9F0A',
  fail: '#FF453A',
};

function bg() {
  return {
    type: 'linear',
    colors: [{ light: '#EDF4FF', dark: '#0B1530' }, { light: '#F3EEFF', dark: '#1A0F33' }, { light: '#F2FBF7', dark: '#06120E' }],
    stops: [0, 0.55, 1],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  };
}

function svgUri(svg) { return 'data:image/svg+xml,' + encodeURIComponent(svg); }

function ringsSvg(values, size, stroke, gap) {
  const h = size / 2;
  let body = '';
  values.forEach((v, i) => {
    const r = h - stroke / 2 - i * (stroke + gap);
    if (r <= stroke / 2) return;
    const c = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(1, Number(v.pct) || 0));
    body += `<circle cx='${h}' cy='${h}' r='${r.toFixed(2)}' fill='none' stroke='${v.color}' stroke-opacity='0.22' stroke-width='${stroke}'/>`;
    if (p > 0) {
      if (p >= 0.999) {
        body += `<circle cx='${h}' cy='${h}' r='${r.toFixed(2)}' fill='none' stroke='${v.color}' stroke-width='${stroke}'/>`;
      } else {
        const a = p * 2 * Math.PI;
        const x = (h + r * Math.sin(a)).toFixed(2), y = (h - r * Math.cos(a)).toFixed(2);
        body += `<path d='M ${h} ${(h - r).toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${p > 0.5 ? 1 : 0} 1 ${x} ${y}' fill='none' stroke='${v.color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
      }
    }
  });
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>${body}</svg>`);
}

function gaugeSvg(pct, color, w) {
  const stroke = 12, r = (w - stroke) / 2, cx = w / 2, cy = w / 2, h = w / 2 + stroke / 2;
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  const pt = a => [(cx - r * Math.cos(a)).toFixed(2), (cy - r * Math.sin(a)).toFixed(2)];
  const [x0, y0] = pt(0), [x1, y1] = pt(Math.PI), [xp, yp] = pt(Math.PI * p);
  let body = `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}' fill='none' stroke='${color}' stroke-opacity='0.22' stroke-width='${stroke}' stroke-linecap='round'/>`;
  if (p > 0.005) body += `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xp} ${yp}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`);
}

function barSvg(pct, color, w, h) {
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  const r = h / 2, fw = p > 0 ? Math.max(h, w * p) : 0;
  return svgUri(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><rect width='${w}' height='${h}' rx='${r}' fill='${color}' fill-opacity='0.2'/>` +
    (fw ? `<rect width='${fw.toFixed(1)}' height='${h}' rx='${r}' fill='${color}'/>` : '') + `</svg>`);
}

function T(value, size, color, weight = 'regular', extra = {}) {
  return { type: 'text', text: String(value), font: { size, weight }, textColor: color || C.text, maxLines: 1, minScale: 0.6, ...extra };
}

// 等宽数字
function M(value, size, color, weight = 'medium', extra = {}) {
  return T(value, size, color, weight, { font: { size, weight, family: 'Menlo' }, ...extra });
}

function icon(name, color, size = 12) {
  return { type: 'image', src: `sf-symbol:${name}`, width: size, height: size, color };
}

function dot(color) {
  return { type: 'stack', width: 6, height: 6, borderRadius: 3, backgroundColor: color, children: [] };
}

function glass(children, extra = {}) {
  return { type: 'stack', direction: 'column', alignItems: 'start', gap: 6, padding: 12, borderRadius: 20, backgroundColor: C.glass, children, ...extra };
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

function header(s) {
  const st = statusOf(s);
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      icon('server.rack', C.accent, 13),
      T(s.name, 13, C.text, 'semibold'),
      { type: 'spacer' },
      dot(st.color),
      T(s.data ? s.data.uptime : st.label, 10, C.dim),
    ],
  };
}

function footer(ctx, s, extra) {
  const parts = [`更新 ${fmtTime(s.updatedAt)}`];
  if (s.mode === 'stale') parts.push('缓存数据');
  if (extra) parts.push(extra);
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
    children: [
      icon('arrow.triangle.2.circlepath', C.dim, 9),
      T(parts.join(' · '), 9, C.dim),
      { type: 'spacer' },
      ...(s.data ? [T(`${s.data.tfSource === 'vnstat' ? 'vnstat' : '月差值'}统计`, 9, C.dim)] : []),
    ],
  };
}

// 指标行：图标 + 名称 + 百分比 + 数值 + 进度条
function metricRow(ic, label, pct, color, valueText, o = {}) {
  const barW = o.barW || 150, barH = o.barH || 5;
  return {
    type: 'stack', direction: 'column', alignItems: 'start', gap: 3,
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
        children: [
          icon(ic, color, o.iconSize || 11),
          T(label, o.labelSize || 11, C.text, 'semibold'),
          M(`${Math.round(pct)}%`, o.pctSize || 11, color, 'bold'),
          { type: 'spacer' },
          M(valueText, o.valueSize || 10, C.dim, 'medium'),
        ],
      },
      { type: 'image', src: barSvg(pct / 100, color, barW, barH), width: barW, height: barH },
    ],
  };
}

/* ---------- 小号 ---------- */

function smallWidget(ctx, s) {
  const d = s.data;
  return {
    type: 'widget', padding: 14, gap: 6, backgroundGradient: bg(), refreshAfter: refreshAt(ctx),
    children: [
      header(s),
      M(d.ip, 9, C.dim, 'bold'),
      { type: 'spacer' },
      metricRow('cpu', 'CPU', d.cpuPct, C.cpu, `${d.cores}C · ${d.load[0]}`, { barW: 150 }),
      metricRow('memorychip', 'MEM', d.memPct, C.mem, `${fmtBytes(d.memUsed)}/${fmtBytes(d.memTotal)}`, { barW: 150 }),
      metricRow('antenna.radiowaves.left.and.right', 'TRAF', d.tfPct, trafficColor(d.tfPct), `${fmtBytes(d.tfUsed)}/${fmtBytes(d.tfTotal)}`, { barW: 150 }),
      { type: 'spacer' },
      footer(ctx, s),
    ],
  };
}

/* ---------- 中号 ---------- */

function mediumWidget(ctx, s) {
  const d = s.data;
  const r = nextReset(ctx.env?.RESET_DAY || 1);
  const st = statusOf(s);
  return {
    type: 'widget', padding: 14, gap: 8, backgroundGradient: bg(), refreshAfter: refreshAt(ctx),
    children: [
      header(s),
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 12, flex: 1,
        children: [
          {
            type: 'stack', direction: 'column', alignItems: 'center', gap: 2, width: 86,
            children: [
              { type: 'image', src: ringsSvg([{ pct: d.cpuPct / 100, color: C.cpu }], 120, 14, 0), width: 74, height: 74 },
              M(`CPU ${d.cpuPct}%`, 12, C.cpu, 'bold'),
              T(`${d.cores}C · 负载 ${d.load[0]}`, 9, C.dim),
            ],
          },
          glass([
            {
              type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
              children: [
                icon('network', C.dim, 10),
                M(d.ip, 10, C.text, 'bold'),
                { type: 'spacer' },
                T(st.label, 9, st.color, 'semibold'),
              ],
            },
            metricRow('memorychip', 'MEM', d.memPct, C.mem, `${fmtBytes(d.memUsed)} / ${fmtBytes(d.memTotal)}`, { barW: 175 }),
            metricRow('internaldrive', 'DSK', d.diskPct, C.disk, `${fmtBytes(d.diskUsed)} / ${fmtBytes(d.diskTotal)}`, { barW: 175 }),
            metricRow('antenna.radiowaves.left.and.right', 'TRAF', d.tfPct, trafficColor(d.tfPct), `↓${fmtBytes(d.tfRx)} ↑${fmtBytes(d.tfTx)}`, { barW: 175 }),
          ], { flex: 1, gap: 6 }),
        ],
      },
      footer(ctx, s, r ? (r.days === 0 ? '今日重置' : `重置 ${r.days} 天`) : null),
    ],
  };
}

/* ---------- 大号 ---------- */

function gaugeCell(ic, label, pct, color, sub) {
  return glass([
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
      children: [icon(ic, color, 11), T(label, 10, C.dim, 'semibold'), { type: 'spacer' }],
    },
    {
      type: 'stack', direction: 'column', alignItems: 'center', gap: -4,
      children: [
        { type: 'image', src: gaugeSvg(pct / 100, color, 64), width: 46, height: 27 },
        M(`${Math.round(pct)}%`, 14, color, 'bold'),
      ],
    },
    M(sub, 9, C.dim, 'medium', { minScale: 0.7 }),
  ], { flex: 1, gap: 3, padding: [8, 10], borderRadius: 16, alignItems: 'center' });
}

function infoCell(k, v) {
  return glass([
    T(k, 10, C.dim, 'medium'),
    M(v, 13, C.text, 'bold', { minScale: 0.7 }),
  ], { flex: 1, padding: [10, 12], borderRadius: 16, gap: 3 });
}

function largeWidget(ctx, s) {
  const d = s.data;
  const r = nextReset(ctx.env?.RESET_DAY || 1);
  const tColor = trafficColor(d.tfPct);
  return {
    type: 'widget', padding: [14, 16], gap: 9, backgroundGradient: bg(), refreshAfter: refreshAt(ctx),
    children: [
      header(s),
      {
        type: 'stack', direction: 'row', gap: 8,
        children: [
          gaugeCell('cpu', 'CPU', d.cpuPct, C.cpu, `${d.cores}C · ${d.load.join(' ')}`),
          gaugeCell('memorychip', 'MEM', d.memPct, C.mem, `${fmtBytes(d.memUsed)}/${fmtBytes(d.memTotal)}`),
          gaugeCell('internaldrive', 'DISK', d.diskPct, C.disk, `${fmtBytes(d.diskUsed)}/${fmtBytes(d.diskTotal)}`),
          gaugeCell('antenna.radiowaves.left.and.right', 'TRAF', d.tfPct, tColor, `${fmtBytes(d.tfUsed)}/${fmtBytes(d.tfTotal)}`),
        ],
      },
      glass([
        {
          type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
          children: [
            icon('arrow.down.circle', C.ok, 11),
            M(fmtBytes(d.tfRx), 12, C.text, 'bold'),
            icon('arrow.up.circle', C.mem, 11),
            M(fmtBytes(d.tfTx), 12, C.text, 'bold'),
            { type: 'spacer' },
            T('剩余', 10, C.dim),
            M(fmtBytes(Math.max(0, d.tfTotal - d.tfUsed)), 12, tColor, 'bold'),
            { type: 'spacer' },
            icon('calendar', C.dim, 10),
            T(r ? (r.days === 0 ? '今日重置' : `重置 ${r.days} 天`) : '不重置', 10, C.dim, 'semibold'),
          ],
        },
        { type: 'image', src: barSvg(d.tfPct / 100, tColor, 300, 6), width: 300, height: 6 },
      ], { gap: 6, padding: [9, 12], borderRadius: 16 }),
      {
        type: 'stack', direction: 'row', gap: 8,
        children: [
          infoCell('运行时长', d.uptime),
          infoCell('IP 地址', d.ip),
          infoCell('系统负载', d.load.join(' / ')),
        ],
      },
      { type: 'spacer' },
      footer(ctx, s, r ? (r.days === 0 ? '今日重置' : `${r.days} 天后重置`) : null),
    ],
  };
}

/* ---------- 锁屏 ---------- */

function lockWidget(ctx, s, family) {
  if (!s.data) {
    return { type: 'widget', children: [{ type: 'text', text: `服务器：${s.mode === 'error' ? '连接失败' : '待配置'}`, font: { size: 12, weight: 'semibold' } }] };
  }
  const d = s.data;
  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: `${s.name} CPU ${d.cpuPct}% · MEM ${d.memPct}% · TRAF ${Math.round(d.tfPct)}%`, maxLines: 1, minScale: 0.6 }] };
  }
  if (family === 'accessoryCircular') {
    return {
      type: 'widget', padding: 8, backgroundImage: ringsSvg([{ pct: d.cpuPct / 100, color: 'white' }], 60, 6, 0),
      children: [
        { type: 'spacer' },
        { type: 'text', text: `${d.cpuPct}%`, font: { size: 14, weight: 'bold' }, textAlign: 'center' },
        { type: 'text', text: 'CPU', font: { size: 9 }, textAlign: 'center', opacity: 0.7 },
        { type: 'spacer' },
      ],
    };
  }
  return {
    type: 'widget', padding: [2, 4], gap: 2,
    children: [
      { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
        { type: 'image', src: 'sf-symbol:server.rack', width: 10, height: 10 },
        { type: 'text', text: s.name, font: { size: 'caption1', weight: 'semibold' }, maxLines: 1, minScale: 0.6 },
        { type: 'spacer' },
        { type: 'text', text: d.uptime, font: { size: 'caption2' }, opacity: 0.7 },
      ]},
      { type: 'text', text: `CPU ${d.cpuPct}% · MEM ${d.memPct}% · DSK ${d.diskPct}%`, font: { size: 'caption1' }, maxLines: 1, minScale: 0.6 },
      { type: 'text', text: `流量 ${fmtBytes(d.tfUsed)} / ${fmtBytes(d.tfTotal)}`, font: { size: 'caption2' }, opacity: 0.7, maxLines: 1, minScale: 0.6 },
    ],
  };
}

/* ---------- 空 / 错误 ---------- */

function emptyWidget(ctx, message, sub) {
  return {
    type: 'widget', padding: 16, gap: 8, backgroundGradient: bg(),
    children: [
      { type: 'stack', direction: 'row', alignItems: 'center', gap: 5, children: [icon('server.rack', C.accent, 13), T('服务器监控', 13, C.text, 'semibold')] },
      { type: 'spacer' },
      icon('exclamationmark.triangle', C.dim, 22),
      T(message, 14, C.text, 'semibold'),
      T(sub, 10, C.dim, 'regular', { maxLines: 3 }),
      { type: 'spacer' },
    ],
  };
}

// ---------------------------------------------------------------------------

export default async function (ctx) {
  const cfg = readConfig(ctx);
  const family = ctx.widgetFamily || 'systemMedium';
  if (!cfg.host) return emptyWidget(ctx, '等待服务器配置', '在 Env 里填 SERVER_HOST，以及 SERVER_PASSWORD 或 SERVER_KEY');
  const s = await loadServer(ctx, cfg);
  if (family.startsWith('accessory')) return lockWidget(ctx, s, family);
  if (!s.data) return emptyWidget(ctx, '无法连接服务器', s.error || '请检查网络与 SSH 配置');
  if (family === 'systemSmall') return smallWidget(ctx, s);
  if (family === 'systemLarge' || family === 'systemExtraLarge') return largeWidget(ctx, s);
  return mediumWidget(ctx, s);
}
