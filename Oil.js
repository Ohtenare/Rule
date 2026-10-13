/**
 * ⛽ 全国实时油价小组件 · Hark 液态玻璃统一版 v2
 * 数据源：http://m.qiyoujiage.com/
 * UI 与「订阅流量监控 / VPS 服务器监控 Hark 改版」统一风格
 *
 * v2 修复：
 *   - region 自动清洗（全角斜杠/空格/大写/非法字符）
 *   - 价格解析改为逐行匹配，不受页面结构微调影响
 *   - 错误提示包含实际请求的 region，方便排查
 *
 * Env：
 *   region          地区（拼音，省份/城市 用 / 分隔），默认 hainan/haikou
 *                   对照表：北京 beijing、上海 shanghai、天津 tianjin、重庆 chongqing
 *                   广东 guangdong/guangzhou、江苏 jiangsu/nanjing、浙江 zhejiang/hangzhou
 *                   山东 shandong/jinan、河南 henan/zhengzhou、河北 hebei/shijiazhuang
 *                   四川 sichuan/chengdu、湖北 hubei/wuhan、湖南 hunan/changsha
 *                   安徽 anhui/hefei、福建 fujian/fuzhou、江西 jiangxi/nanchang
 *                   辽宁 liaoning/shenyang、陕西 shanxi-3/xian、海南 hainan/haikou
 *                   山西 shanxi-1/taiyuan、吉林 jilin/changchun、黑龙江 heilongjiang/haerbin
 *                   云南 yunnan/kunming、贵州 guizhou/guiyang、广西 guangxi/nanning
 *                   甘肃 gansu/lanzhou、青海 qinghai/xining、宁夏 ningxia/yinchuan
 *                   新疆 xinjiang/wulumuqi、西藏 xizang/lasa、内蒙古 neimenggu/huhehaote
 *   SHOW_TREND      是否显示调价趋势，默认 true
 *   REFRESH_HOURS   刷新间隔（小时，0.5~24），默认 6
 */

// ---------------------------------------------------------------------------
// 配置 & 数据加载
// ---------------------------------------------------------------------------

function readConfig(ctx) {
  const env = ctx.env || {};
  // region 自动清洗：全角斜杠/空格、大写、结尾斜杠、非法字符
  const region = String(env.region || 'hainan/haikou')
    .trim()
    .replace(/[　]/g, ' ')           // 全角空格
    .replace(/[／\/\\]+/g, '/')      // 全角斜杠、反斜杠、连续斜杠 → 单个 /
    .replace(/\s+/g, '')             // 去掉所有空格
    .toLowerCase()
    .replace(/[^a-z0-9\-/]/g, '')    // 只留拼音字符
    .replace(/^\/+|\/+$/g, '');      // 去掉首尾斜杠
  return {
    region: region || 'hainan/haikou',
    showTrend: String(env.SHOW_TREND ?? 'true').trim() !== 'false',
    refreshHours: (() => {
      const v = Number(env.REFRESH_HOURS);
      return Number.isFinite(v) && v > 0 ? Math.min(24, Math.max(0.5, v)) : 6;
    })(),
  };
}

function parseTrend(html) {
  const m = html.match(/<div class="tishi">[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<br\/>([\s\S]+?)<br\/>/);
  if (!m || m.length < 3) return '';
  const datePart = m[1].split('价')[1]?.slice(0, -2) || '';
  const valuePart = m[2];
  const arrow = (valuePart.includes('下调') || valuePart.includes('下跌')) ? '↓' : '↑';
  let amount = '';
  const perLiter = valuePart.match(/([\d.]+)\s*元\/升/g);
  if (perLiter && perLiter.length >= 2) {
    const nums = perLiter.map(p => p.match(/([\d.]+)/)[1]);
    amount = `${nums[0]}-${nums[1]}元/L`;
  } else {
    const perTon = valuePart.match(/(\d+)\s*元(?:\/吨)?/g);
    if (perTon && perTon.length >= 2) {
      const nums = perTon.map(p => p.match(/(\d+)/)[1]);
      amount = `${nums[0]}-${nums[1]}元/吨`;
    } else {
      const single = valuePart.match(/([\d.]+)\s*元\/升/);
      if (single) amount = `${single[1]}元/L`;
    }
  }
  return `${datePart}调整 ${arrow} ${amount}`.trim();
}

// 按行清洗后逐行匹配，比跨行正则更稳
function parsePrices(html) {
  const nameMap = [
    [/92/, 'p92'], [/95/, 'p95'], [/98/, 'p98'],
    [/0\s*号|柴油/, 'diesel'],
  ];
  const prices = { p92: null, p95: null, p98: null, diesel: null };
  let matched = 0;

  // 把标签拆成单行再匹配，避免跨行正则受页面结构微调影响
  const rows = html.replace(/>\s+</g, '>\n<').split('\n');
  for (let i = 0; i < rows.length; i++) {
    const dt = rows[i].match(/<dt>([^<]*油)<\/dt>/);
    if (!dt) continue;
    // dd 可能在同一行或下一行
    const dd = rows[i].match(/<dd>([\d.]+)$元$<\/dd>/) || (rows[i + 1] || '').match(/<dd>([\d.]+)$元$<\/dd>/);
    if (!dd) continue;
    const v = parseFloat(dd[1]);
    if (isNaN(v)) continue;
    const hit = nameMap.find(([re]) => re.test(dt[1]));
    if (hit && prices[hit[1]] === null) {
      prices[hit[1]] = v;
      matched++;
    }
  }
  return matched >= 3 ? prices : null;
}

// 加载 + 缓存：成功存 live，失败回退 stale，无缓存报 error
async function loadOil(ctx, cfg) {
  const key = `egern.oilprice.hark.v2.${cfg.region}`;
  try {
    const resp = await ctx.http.get(`http://m.qiyoujiage.com/${cfg.region}.shtml`, {
      headers: {
        referer: 'http://m.qiyoujiage.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
      timeout: 15000,
    });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}（检查 region 是否为拼音，如 hainan/haikou）`);
    const html = await resp.text();

    let regionName = '';
    const titleMatch = html.match(/<title>([^_]+)_/);
    if (titleMatch?.[1]) {
      regionName = titleMatch[1].trim().replace(/(油价|实时|今日|最新|查询|价格)/g, '').trim();
    }
    const prices = parsePrices(html);
    if (!prices) throw new Error(`价格解析失败（region=${cfg.region}，页面结构可能变动）`);

    const data = {
      prices,
      regionName,
      trendInfo: cfg.showTrend ? parseTrend(html) : '',
    };
    const result = { mode: 'live', data, updatedAt: Date.now() };
    try { ctx.storage?.setJSON(key, result); } catch {}
    return result;
  } catch (error) {
    const msg = String(error?.message || error || '加载失败');
    let cached = null;
    try { cached = ctx.storage?.getJSON(key); } catch {}
    if (cached?.data) return { ...cached, mode: 'stale', error: msg };
    return { mode: 'error', error: msg, updatedAt: 0 };
  }
}

// ---------------------------------------------------------------------------
// 计算
// ---------------------------------------------------------------------------

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function statusOf(s) {
  if (s.mode === 'error') return { label: '失败', color: C.fail };
  if (s.mode === 'stale') return { label: '缓存', color: C.warn };
  return { label: '正常', color: C.ok };
}

function refreshAt(cfg) {
  return new Date(Date.now() + cfg.refreshHours * 3600000).toISOString();
}

function fuelRows(data) {
  return [
    { label: '92号', price: data.prices.p92, color: C.p92 },
    { label: '95号', price: data.prices.p95, color: C.p95 },
    { label: '98号', price: data.prices.p98, color: C.p98 },
    { label: '柴油', price: data.prices.diesel, color: C.diesel },
  ].filter(r => r.price !== null);
}

// ---------------------------------------------------------------------------
// 视觉：iOS 液态玻璃（油价暖色主题）
// ---------------------------------------------------------------------------

const C = {
  text: { light: '#000000', dark: '#FFFFFF' },
  dim:  { light: '#3C3C4399', dark: '#EBEBF599' },
  glass: { light: '#FFFFFFA6', dark: '#FFFFFF1A' },
  accent: '#FF9F0A',
  p92: '#FF9F0A',
  p95: '#FF6B35',
  p98: '#FF453A',
  diesel: '#30D158',
  ok: '#30D158',
  warn: '#FF9F0A',
  fail: '#FF453A',
};

function bg() {
  return {
    type: 'linear',
    colors: [{ light: '#FFF6EC', dark: '#2A1A0B' }, { light: '#FFF1F0', dark: '#260F0F' }, { light: '#F2FBF7', dark: '#06120E' }],
    stops: [0, 0.55, 1],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  };
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
// 布局
// ---------------------------------------------------------------------------

function header(s) {
  const st = statusOf(s);
  const name = s.data?.regionName ? `${s.data.regionName}油价` : '实时油价';
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      icon('fuelpump.fill', C.accent, 13),
      T(name, 13, C.text, 'semibold'),
      { type: 'spacer' },
      dot(st.color),
      T(s.mode === 'stale' ? '缓存' : `更新 ${fmtTime(s.updatedAt)}`, 10, C.dim),
    ],
  };
}

function footer(s) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
    children: [
      icon('arrow.triangle.2.circlepath', C.dim, 9),
      T(`更新 ${fmtTime(s.updatedAt)}${s.mode === 'stale' ? ' · 缓存数据' : ''}`, 9, C.dim),
      { type: 'spacer' },
      T('元/升', 9, C.dim),
    ],
  };
}

function trendLine(s) {
  if (!s.data?.trendInfo) return null;
  const down = s.data.trendInfo.includes('↓');
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
    children: [
      icon(down ? 'arrow.down.right' : 'arrow.up.right', down ? C.ok : C.fail, 10),
      T(s.data.trendInfo.replace(/\s+/g, ' '), 10, C.dim, 'medium'),
    ],
  };
}

// 油价卡：标签胶囊 + 大数字
function priceCard(row, o = {}) {
  return glass([
    {
      type: 'stack', direction: 'row', alignItems: 'center', justifyContent: 'center',
      padding: [2, 8], borderRadius: 6,
      backgroundColor: { light: row.color + '28', dark: row.color + '28' },
      children: [T(row.label, o.labelSize || 10, row.color, 'bold', { textAlign: 'center' })],
    },
    M(row.price.toFixed(2), o.priceSize || 20, C.text, 'bold', { textAlign: 'center', minScale: 0.7 }),
    ...(o.unit ? [T('元/升', 9, C.dim, 'medium', { textAlign: 'center' })] : []),
  ], { flex: 1, alignItems: 'center', gap: o.gap ?? 3, padding: o.padding || [8, 6], borderRadius: 14 });
}

/* ---------- 小号 ---------- */

function smallWidget(ctx, cfg, s) {
  const rows = fuelRows(s.data);
  const pairs = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push(rows.slice(i, i + 2));
  return {
    type: 'widget', padding: 12, gap: 6, backgroundGradient: bg(), refreshAfter: refreshAt(cfg),
    children: [
      header(s),
      ...(trendLine(s) ? [trendLine(s)] : []),
      { type: 'spacer' },
      ...pairs.map(pair => ({
        type: 'stack', direction: 'row', gap: 6, flex: 1,
        children: pair.length === 1
          ? [priceCard(pair[0], { priceSize: 16 }), { type: 'spacer', flex: 1 }]
          : pair.map(r => priceCard(r, { priceSize: 16 })),
      })),
      { type: 'spacer' },
      footer(s),
    ],
  };
}

/* ---------- 中号 ---------- */

function mediumWidget(ctx, cfg, s) {
  const rows = fuelRows(s.data);
  return {
    type: 'widget', padding: [12, 14], gap: 8, backgroundGradient: bg(), refreshAfter: refreshAt(cfg),
    children: [
      header(s),
      {
        type: 'stack', direction: 'row', gap: 7, flex: 1, alignItems: 'center',
        children: rows.map(r => priceCard(r, { priceSize: 19, unit: true, padding: [9, 4] })),
      },
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
        children: [
          ...(trendLine(s) ? [trendLine(s)] : []),
          { type: 'spacer' },
          T(`更新 ${fmtTime(s.updatedAt)}${s.mode === 'stale' ? ' · 缓存' : ''} · 元/升`, 9, C.dim),
        ],
      },
    ],
  };
}

/* ---------- 大号 ---------- */

function largeWidget(ctx, cfg, s) {
  const rows = fuelRows(s.data);
  const st = statusOf(s);
  const cheapest = rows.length ? rows.reduce((a, b) => (a.price <= b.price ? a : b)) : null;
  return {
    type: 'widget', padding: [14, 16], gap: 10, backgroundGradient: bg(), refreshAfter: refreshAt(cfg),
    children: [
      header(s),
      {
        type: 'stack', direction: 'row', gap: 8,
        children: rows.map(r => priceCard(r, { priceSize: 24, labelSize: 11, unit: true, gap: 4, padding: [12, 6] })),
      },
      {
        type: 'stack', direction: 'row', gap: 8,
        children: [
          glass([
            T('调价趋势', 10, C.dim, 'medium'),
            s.data.trendInfo
              ? T(s.data.trendInfo, 13, s.data.trendInfo.includes('↓') ? C.ok : C.fail, 'bold', { minScale: 0.8 })
              : T('暂无调价信息', 13, C.dim, 'semibold'),
          ], { flex: 1, padding: [10, 12], borderRadius: 16, gap: 3 }),
          glass([
            T('最低油价', 10, C.dim, 'medium'),
            cheapest
              ? T(`${cheapest.label} ${cheapest.price.toFixed(2)} 元`, 13, cheapest.color, 'bold')
              : T('--', 13, C.dim, 'semibold'),
          ], { flex: 1, padding: [10, 12], borderRadius: 16, gap: 3 }),
          glass([
            T('数据状态', 10, C.dim, 'medium'),
            T(st.label, 13, st.color, 'bold'),
          ], { flex: 1, padding: [10, 12], borderRadius: 16, gap: 3 }),
        ],
      },
      { type: 'spacer' },
      footer(s),
    ],
  };
}

/* ---------- 锁屏 ---------- */

function lockWidget(ctx, cfg, s, family) {
  if (!s.data || !fuelRows(s.data).length) {
    return { type: 'widget', refreshAfter: refreshAt(cfg), children: [{ type: 'text', text: `油价：${s.mode === 'error' ? '获取失败' : '暂无数据'}`, font: { size: 12, weight: 'semibold' } }] };
  }
  const rows = fuelRows(s.data);
  const place = s.data.regionName || '油价';
  const SUB = { light: '#FFFFFFB3', dark: '#FFFFFFB3' };

  if (family === 'accessoryInline') {
    return {
      type: 'widget', refreshAfter: refreshAt(cfg),
      children: [{ type: 'text', text: `${place} ${rows.slice(0, 2).map(r => `${r.label} ${r.price.toFixed(2)}`).join(' · ')}`, font: { size: 'caption1', weight: 'medium' }, maxLines: 1, minScale: 0.5 }],
    };
  }

  if (family === 'accessoryCircular') {
    const r0 = rows.find(r => r.label.includes('92')) || rows[0];
    return {
      type: 'widget', padding: 2, refreshAfter: refreshAt(cfg),
      children: [
        { type: 'spacer' },
        { type: 'text', text: r0.label, font: { size: 'caption2', weight: 'medium' }, textColor: SUB, textAlign: 'center', maxLines: 1 },
        { type: 'text', text: r0.price.toFixed(2), font: { size: 'headline', weight: 'bold' }, textAlign: 'center', maxLines: 1, minScale: 0.5 },
        { type: 'text', text: '元/升', font: { size: 'caption2' }, textColor: SUB, textAlign: 'center', maxLines: 1 },
        { type: 'spacer' },
      ],
    };
  }

  // 矩形
  const cell = r => ({
    type: 'stack', direction: 'row', alignItems: 'center', flex: 1, gap: 4,
    children: [
      { type: 'text', text: r.label, font: { size: 'caption2', weight: 'medium' }, textColor: SUB, maxLines: 1 },
      { type: 'spacer' },
      { type: 'text', text: r.price.toFixed(2), font: { size: 'caption1', weight: 'bold' }, maxLines: 1, minScale: 0.6 },
    ],
  });
  const pairs = [];
  for (let i = 0; i < rows.length; i += 2) pairs.push(rows.slice(i, i + 2));
  return {
    type: 'widget', padding: 2, gap: 3, refreshAfter: refreshAt(cfg),
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
        children: [
          { type: 'image', src: 'sf-symbol:fuelpump.fill', width: 11, height: 11 },
          { type: 'text', text: place, font: { size: 'caption2', weight: 'semibold' }, maxLines: 1, minScale: 0.7 },
          { type: 'spacer' },
          ...(s.mode === 'stale' ? [{ type: 'text', text: '缓存', font: { size: 'caption2' }, textColor: SUB, maxLines: 1 }] : []),
        ],
      },
      ...pairs.map(pair => ({
        type: 'stack', direction: 'row', alignItems: 'center', gap: 10,
        children: pair.length === 1 ? [cell(pair[0]), { type: 'spacer' }] : pair.map(cell),
      })),
    ],
  };
}

/* ---------- 空 / 错误 ---------- */

function emptyWidget(cfg, message, sub) {
  return {
    type: 'widget', padding: 16, gap: 8, backgroundGradient: bg(), refreshAfter: refreshAt(cfg),
    children: [
      { type: 'stack', direction: 'row', alignItems: 'center', gap: 5, children: [icon('fuelpump.fill', C.accent, 13), T('实时油价', 13, C.text, 'semibold')] },
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
  const s = await loadOil(ctx, cfg);
  if (family.startsWith('accessory')) return lockWidget(ctx, cfg, s, family);
  if (!s.data || !fuelRows(s.data).length) {
    return emptyWidget(cfg, '无法获取油价', s.error || '请检查 region 配置（如 hainan/haikou）或网络');
  }
  if (family === 'systemSmall') return smallWidget(ctx, cfg, s);
  if (family === 'systemLarge' || family === 'systemExtraLarge') return largeWidget(ctx, cfg, s);
  return mediumWidget(ctx, cfg, s);
}
