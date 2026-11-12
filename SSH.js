/**
 * ===========================================================================
 * vnStat 快速安装与配置指南 (适用于 Debian/Ubuntu)
 * ===========================================================================
 * 1. 安装 vnStat：
 *    apt update && apt install vnstat -y
 *
 * 2. 设置开机自启并启动服务：
 *    systemctl enable --now vnstat
 *
 * 3. （可选）修改 vnstat 自身的月度分界日：
 *    sed -i -E 's/^;?MonthRotate [0-9]+/MonthRotate 12/' /etc/vnstat.conf
 *    systemctl restart vnstat
 *    注意：本脚本按 RESET_DAY 汇总 vnstat 的「每日」数据，MonthRotate 只影响
 *    vnstat -m 的月度报表，不影响小组件数字，无需与面板计费日保持一致。
 * ===========================================================================
 * 
 * Egern 小组件：VPS 服务器监控 · Hark 液态玻璃 Apple 健身圆环版 v3.9
 * 优化：集成 vnstat 指南注释，修正 vnstat 2.x 的 JSON 采集参数
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
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.***`;
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
    // 只统计物理网卡，排除 docker0 / veth / br- 等虚拟接口（否则流量会被重复计算）
    "awk '/^ *(eth|ens|enp|eno|enx|wlan|wlp|venet|bond)/{rx+=$2;tx+=$10}END{print rx+0,tx+0}' /proc/net/dev",
    'vnstat --json 2>/dev/null || echo ""',
  ];
  const { stdout } = await session.exec(cmds.join(` && echo '${SEP}' && `));
  await session.close();
  return stdout.split(SEP).map(s => s.trim());
}

// ---------------------------------------------------------------------------
// vnstat 数据解析辅助
// ---------------------------------------------------------------------------

const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|cni|flannel|kube|podman|tun|tap|wg|zt|tailscale|dummy|ifb|gre|sit|ip6)/i;
const PHYSICAL_IFACE = /^(eth|ens|enp|eno|enx|en|wlan|wlp|venet|bond)/i;

// 从 vnstat JSON 中挑出真正承载业务流量的网卡（默认第一个可能是 docker0）
function pickTrafficInterface(vn) {
  const list = Array.isArray(vn?.interfaces)
    ? vn.interfaces
    : Object.values(vn?.interfaces || {});
  if (!list.length) return null;

  const bytes = (i) => {
    const t = i?.traffic?.total || {};
    return (Number(t.rx) || 0) + (Number(t.tx) || 0);
  };

  const physical = list.filter(i => {
    const n = String(i?.name || '');
    return PHYSICAL_IFACE.test(n) && !VIRTUAL_IFACE.test(n);
  });
  const nonVirtual = list.filter(i => !VIRTUAL_IFACE.test(String(i?.name || '')));
  const pool = physical.length ? physical : (nonVirtual.length ? nonVirtual : list);
  return pool.reduce((best, i) => (bytes(i) > bytes(best) ? i : best), pool[0]);
}

function dayStamp(item) {
  const d = item?.date || item;
  if (!d || !d.year || !d.month || !d.day) return null;
  return new Date(d.year, d.month - 1, d.day).getTime();
}

function monthStamp(item) {
  const d = item?.date || item;
  if (!d || !d.year || !d.month) return null;
  return new Date(d.year, d.month - 1, 1).getTime();
}

// 当前计费周期起点（按 resetDay，处理跨月与短月）
function cycleStartOf(now, resetDay) {
  const day = Math.min(Math.max(1, Number(resetDay) || 1), 31);
  let y = now.getFullYear();
  let m = now.getMonth();
  if (now.getDate() < day) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  const lastDay = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(day, lastDay)).getTime();
}

function parseMetrics(ctx, cfg, p, key) {
  const hostname = p[0] || 'Server';
  const load = (p[1] || '0 0 0').split(' ').slice(0, 3);

  const upSec = parseFloat((p[2] || '0').split(' ')[0]) || 0;
  const upDays = Math.floor(upSec / 86400);
  const upHours = Math.floor((upSec % 86400) / 3600);
  const upMins = Math.floor((upSec % 3600) / 60);
  const uptime = upDays > 0 ? `${upDays}天 ${upHours}小时` : `${upHours}小时 ${upMins}分`;

  // CPU 差值计算
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

  // 流量统计：取 vnstat「每日」数据，按计费周期（RESET_DAY）累加
  // 修正：1) 不再固定取 interfaces[0]（实测首项常是 docker0，只有几百 MB）
  //      2) vnstat 2.x 的 JSON 单位是字节，不能再 *1024
  let tfRx = 0, tfTx = 0, tfSource = '月差值';
  if (p[8]) {
    try {
      const vn = JSON.parse(p[8]);
      const iface = pickTrafficInterface(vn);
      const traffic = iface?.traffic || {};
      const dayArr = Array.isArray(traffic.day) ? traffic.day : [];
      const monthArr = Array.isArray(traffic.month) ? traffic.month : [];
      const unit = String(vn.jsonversion) === '2' ? 1 : 1024;

      if (dayArr.length || monthArr.length) {
        const resetDay = cfg.resetDay || 1;
        // 用 vnstat 的 updated 日期代表「服务器今天」，避免手机与服务端时区不一致
        const upd = traffic.updated || iface?.updated;
        const nowSrv = upd?.date
          ? new Date(upd.date.year, upd.date.month - 1, upd.date.day)
          : new Date();
        const startTime = cycleStartOf(nowSrv, resetDay);
        const endTime = new Date(nowSrv.getFullYear(), nowSrv.getMonth(), nowSrv.getDate()).getTime();

        let rx = 0, tx = 0, hits = 0;
        for (const item of dayArr) {
          const t = dayStamp(item);
          if (t === null || t < startTime || t > endTime) continue;
          rx += Number(item.rx) || 0;
          tx += Number(item.tx) || 0;
          hits++;
        }

        if (hits > 0) {
          tfRx = rx * unit;
          tfTx = tx * unit;
          tfSource = 'vnstat·周期';
        } else if (monthArr.length) {
          // 周期内没有日数据（周期刚开始 / 日记录被清理）时退回最新月份
          const latest = monthArr.reduce((a, b) => ((monthStamp(b) || 0) > (monthStamp(a) || 0) ? b : a));
          tfRx = (Number(latest.rx) || 0) * unit;
          tfTx = (Number(latest.tx) || 0) * unit;
          tfSource = 'vnstat·月';
        }
      }
    } catch (e) {
      console.log('vnstat parse error:', e);
    }
  }

  // 如果 vnStat 解析失败，则回退到原有的“月差值”本地计算逻辑
  if (tfSource === '月差值') {
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
// 计算与 SVG 绘图
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
    const p = Math.max(0, Math.min(1, Number(v.pct) || 0));
    body += `<circle cx='${h}' cy='${h}' r='${r.toFixed(2)}' fill='none' stroke='${v.color}' stroke-opacity='0.22' stroke-width='${stroke}'/>`;
    if (p > 0.005) {
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
// 布局组件
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
      T(st.label, 10, st.color, 'semibold'),
      T('·', 10, C.dim),
      T(s.data ? s.data.uptime : st.label, 10, C.dim),
    ],
  };
}

function smallHeader(s) {
  const st = statusOf(s);
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      icon('server.rack', C.accent, 12),
      T(s.name, 12, C.text, 'semibold'),
      { type: 'spacer' },
      dot(st.color),
      T(st.label, 10, st.color, 'semibold'),
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
      ...(s.data ? [T(`${s.data.tfSource}`, 9, C.dim)] : []),
    ],
  };
}

function metricRow(ic, label, pct, color, valueText, o = {}) {
  const barW = o.barW || 165, barH = o.barH || 4;
  return {
    type: 'stack', direction: 'column', alignItems: 'start', gap: 2,
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
        children: [
          icon(ic, color, 10),
          T(label, 10, C.text, 'semibold'),
          { type: 'spacer' },
          M(valueText, 9, C.dim, 'medium', { minScale: 0.6 }),
        ],
      },
      { type: 'image', src: barSvg(pct / 100, color, barW, barH), width: barW, height: barH },
    ],
  };
}

/* ---------- 小号组件 ---------- */

function smallWidget(ctx, s) {
  const d = s.data;
  const tColor = trafficColor(d.tfPct);
  return {
    type: 'widget', padding: 12, gap: 5, backgroundGradient: bg(), refreshAfter: refreshAt(ctx),
    children: [
      smallHeader(s),
      { type: 'spacer' },
      metricRow('cpu', 'CPU', d.cpuPct, C.cpu, `${d.cores}C · ${d.cpuPct}%`, { barW: 145, barH: 4 }),
      metricRow('memorychip', 'MEM', d.memPct, C.mem, `${fmtBytes(d.memUsed)}/${fmtBytes(d.memTotal)}`, { barW: 145, barH: 4 }),
      metricRow('internaldrive', 'DSK', d.diskPct, C.disk, `${fmtBytes(d.diskUsed)}/${fmtBytes(d.diskTotal)}`, { barW: 145, barH: 4 }),
      metricRow('antenna.radiowaves.left.and.right', 'TRAF', d.tfPct, tColor, `${fmtBytes(d.tfUsed)} / ${fmtBytes(d.tfTotal)}`, { barW: 145, barH: 4 }),
      { type: 'spacer' },
      {
        type: 'stack', direction: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
        children: [
          T('负载', 9, C.dim),
          M(d.load.join(' / '), 9, C.text, 'medium', { minScale: 0.6 })
        ]
      }
    ],
  };
}

/* ---------- 中号 ---------- */

function mediumWidget(ctx, s) {
  const d = s.data;
  const r = nextReset(ctx.env?.RESET_DAY || 1);
  const tColor = trafficColor(d.tfPct);

  const ringValues = [
    { pct: d.cpuPct / 100, color: C.cpu },
    { pct: d.memPct / 100, color: C.mem },
    { pct: d.diskPct / 100, color: C.disk },
    { pct: d.tfPct / 100, color: tColor },
  ];

  return {
    type: 'widget', padding: [8, 14], gap: 8, backgroundGradient: bg(), refreshAfter: refreshAt(ctx),
    children: [
      header(s),
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 12, flex: 1,
        children: [
          {
            type: 'stack', direction: 'column', alignItems: 'center', gap: 3, width: 88,
            children: [
              { type: 'image', src: ringsSvg(ringValues, 120, 8, 2), width: 76, height: 76 },
              M(d.ip, 9, C.dim, 'bold'),
              T(d.load.join(' / '), 9, C.dim, 'regular', { minScale: 0.5 }),
            ],
          },
          glass([
            metricRow('cpu', 'CPU', d.cpuPct, C.cpu, `${d.cores}C · ${d.cpuPct}%`, { barW: 175, barH: 4 }),
            metricRow('memorychip', 'MEM', d.memPct, C.mem, `${fmtBytes(d.memUsed)}/${fmtBytes(d.memTotal)}`, { barW: 175, barH: 4 }),
            metricRow('internaldrive', 'DSK', d.diskPct, C.disk, `${fmtBytes(d.diskUsed)}/${fmtBytes(d.diskTotal)}`, { barW: 175, barH: 4 }),
            metricRow('antenna.radiowaves.left.and.right', 'TRAF', d.tfPct, tColor, `${fmtBytes(d.tfUsed)} / ${fmtBytes(d.tfTotal)}`, { barW: 175, barH: 4 }),
          ], { flex: 1, gap: 8, padding: [12, 14] }),
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
  if (!cfg.host) return emptyWidget(ctx, '等待服务器配置', '在 Env 里填 SERVER_HOST，以及 SERVER_PASSWORD || SERVER_KEY');
  const s = await loadServer(ctx, cfg);
  if (family.startsWith('accessory')) return lockWidget(ctx, s, family);
  if (!s.data) return emptyWidget(ctx, '无法连接服务器', s.error || '请检查网络与 SSH 配置');
  if (family === 'systemSmall') return smallWidget(ctx, s);
  if (family === 'systemLarge' || family === 'systemExtraLarge') return largeWidget(ctx, s);
  return mediumWidget(ctx, s);
}
