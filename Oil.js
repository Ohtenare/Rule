/**
 * ⛽ 全国实时油价小组件 · 液态玻璃版
 * 数据源：http://m.qiyoujiage.com/
 * 数据层（请求头 / 解析正则）与已验证可用的原版 Oil_Widget.JS 完全一致，仅重写 UI
 *
 * 🔧 功能特性：
 * - 液态玻璃渐变背景 + 玻璃卡片（与机场订阅组件同风格）
 * - 实时显示 92/95/98 号汽油和柴油价格
 * - 状态点指示：绿=实时 黄=缓存 红=失败
 * - 网络失败时自动显示缓存数据并标注「缓存 HH:mm」
 * - 支持锁屏小组件（单行 / 圆形 / 矩形）
 * - 深色模式自动适配
 *
 * 📚 环境变量
 * ─────────────────────────────────────────────────
 * 名称：region
 * 值：省份/城市（拼音，用 / 分隔），默认 hainan/haikou
 *
 * 名称：SHOW_TREND
 * 值：true（显示调价趋势）或 false（不显示），默认 true
 *
 * 名称：REFRESH_HOURS
 * 值：自动刷新间隔（小时），默认 6，范围 1-48
 *
 * 地区代码对照表
 * ─────────────────────────────────────────────────
 * 【直辖市】北京 beijing ・ 上海 shanghai ・ 天津 tianjin ・ 重庆 chongqing
 * 广东 guangdong/guangzhou   江苏 jiangsu/nanjing
 * 浙江 zhejiang/hangzhou     山东 shandong/jinan
 * 河南 henan/zhengzhou       河北 hebei/shijiazhuang
 * 四川 sichuan/chengdu       湖北 hubei/wuhan
 * 湖南 hunan/changsha        安徽 anhui/hefei
 * 福建 fujian/fuzhou         江西 jiangxi/nanchang
 * 辽宁 liaoning/shenyang     陕西 shanxi-3/xian ⚠️
 * 海南 hainan/haikou         山西 shanxi-1/taiyuan ⚠️
 * 吉林 jilin/changchun       黑龙江 heilongjiang/haerbin
 * 云南 yunnan/kunming        贵州 guizhou/guiyang
 * 广西 guangxi/nanning       甘肃 gansu/lanzhou
 * 青海 qinghai/xining        宁夏 ningxia/yinchuan
 * 新疆 xinjiang/wulumuqi     西藏 xizang/lasa
 * 内蒙古 neimenggu/huhehaote
 * 也可去 http://m.qiyoujiage.com/shanxi-3.shtml 查自己城市拼音
 * ─────────────────────────────────────────────────
 */

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  return (hash >>> 0).toString(36);
}

export default async function (ctx) {
  const env = ctx.env || {};

  // 地区参数清洗：全角空格/斜杠、空白、大小写、非法字符
  const regionParam = (String(env.region || 'hainan/haikou')
    .trim()
    .replace(/[　]/g, ' ')
    .replace(/[／\\]+/g, '/')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\-/]/g, '')
    .replace(/^\/+|\/+$/g, '')) || 'hainan/haikou';

  const SHOW_TREND = String(env.SHOW_TREND || 'true').trim() !== 'false';
  const REFRESH_HOURS = Math.min(48, Math.max(1, Number(env.REFRESH_HOURS) || 6));
  const refreshTime = new Date(Date.now() + REFRESH_HOURS * 3600 * 1000).toISOString();

  const now = new Date();

  // ── 颜色 ─────────────────────────────────────────
  const C = {
    text:   { light: '#1C1C1E', dark: '#FFFFFF' },
    sub:    { light: '#5A5A5E', dark: '#EBEBF599' },
    dim:    { light: '#8E8E93', dark: '#8E8E93' },
    p92:    { light: '#E8890C', dark: '#FFB347' },
    p95:    { light: '#FF6B35', dark: '#FF8A5C' },
    p98:    { light: '#FF3B30', dark: '#FF6B6B' },
    diesel: { light: '#28A745', dark: '#5CD67D' },
    ok:     { light: '#34C759', dark: '#30D158' },
    warn:   { light: '#FF9500', dark: '#FF9F0A' },
    bad:    { light: '#FF3B30', dark: '#FF453A' },
  };

  const bg = () => ({
    type: 'linear',
    colors: [
      { light: '#FFF4E3', dark: '#25221B' },
      { light: '#FFE9DD', dark: '#2A1F1C' },
      { light: '#E9F6EC', dark: '#1A241F' },
    ],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  });
  const glass = () => ({ light: '#FFFFFFA6', dark: '#FFFFFF1A' });
  const glassBorder = () => ({ light: '#0000000F', dark: '#FFFFFF26' });

  const T = (text, size, weight, color, extra) =>
    Object.assign({ type: 'text', text, font: { size, weight }, textColor: color }, extra || {});
  const icon = (name, size, color) =>
    ({ type: 'image', src: `sf-symbol:${name}`, width: size, height: size, color });
  const dot = (color) =>
    ({ type: 'stack', width: 7, height: 7, borderRadius: 4, backgroundColor: color });

  // ── 数据层：与原版完全一致（URL / 请求头 / 正则） ──
  async function fetchOil() {
    const queryAddr = `http://m.qiyoujiage.com/${regionParam}.shtml`;

    const resp = await ctx.http.get(queryAddr, {
      headers: {
        'referer': 'http://m.qiyoujiage.com/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 15000
    });

    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);

    const html = await resp.text();

    let regionName = '';
    const titleMatch = html.match(/<title>([^_]+)_/);
    if (titleMatch && titleMatch[1]) {
      regionName = titleMatch[1].trim().replace(/(油价|实时|今日|最新|查询|价格)/g, '').trim();
    }

    const regPrice = /<dl>[\s\S]+?<dt>(.*油)<\/dt>[\s\S]+?<dd>(.*)\(元\)<\/dd>/gm;
    const priceList = [];
    let m = null;
    while ((m = regPrice.exec(html)) !== null) {
      if (m.index === regPrice.lastIndex) regPrice.lastIndex++;
      priceList.push({ name: m[1].trim(), value: m[2].trim() });
    }
    if (priceList.length < 3) throw new Error('解析失败');

    const nameMap = {
      '92 号': 'p92', '92': 'p92',
      '95 号': 'p95', '95': 'p95',
      '98 号': 'p98', '98': 'p98',
      '0 号': 'diesel', '柴油': 'diesel'
    };
    const prices = { p92: null, p95: null, p98: null, diesel: null };
    priceList.forEach(item => {
      const key = Object.keys(nameMap).find(k => item.name.includes(k));
      if (key) {
        const v = parseFloat(item.value);
        if (!isNaN(v)) prices[nameMap[key]] = v;
      }
    });

    let trendInfo = '';
    if (SHOW_TREND) {
      const regTrend = /<div class="tishi">[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<br\/>([\s\S]+?)<br\/>/;
      const trendMatch = html.match(regTrend);
      if (trendMatch && trendMatch.length >= 3) {
        const sp = trendMatch[1].split('价');
        const datePart = sp[1] ? sp[1].slice(0, -2) : '';
        const valuePart = trendMatch[2];
        const trend = (valuePart.includes('下调') || valuePart.includes('下跌')) ? '↓' : '↑';
        let amount = '';
        const allPrices = valuePart.match(/([\d\.]+)\s*元\/升/g);
        if (allPrices && allPrices.length >= 2) {
          const nums = allPrices.map(p => p.match(/([\d\.]+)/)[1]);
          amount = `${nums[0]}-${nums[1]}`;
        } else {
          const allTons = valuePart.match(/([\d]+)\s*元(?:\/吨)?/g);
          if (allTons && allTons.length >= 2) {
            const nums = allTons.map(p => p.match(/([\d]+)/)[1]);
            amount = `${nums[0]}-${nums[1]}元/吨`;
          } else {
            const singleMatch = valuePart.match(/([\d\.]+)\s*元\/升/);
            if (singleMatch) amount = `${singleMatch[1]}元/L`;
          }
        }
        trendInfo = `${datePart}调整 ${trend} ${amount}`.trim();
      }
    }

    return { prices, regionName, trendInfo };
  }

  // ── 获取数据：live / stale / error ────────────────
  const CACHE_KEY = `egern.oil.hark.v1.${hashString(regionParam)}`;
  let data = null;
  let mode = 'error';
  let errorMsg = '';

  try {
    const fresh = await fetchOil();
    data = { prices: fresh.prices, regionName: fresh.regionName, trendInfo: fresh.trendInfo, ts: Date.now() };
    mode = 'live';
    try { ctx.storage.setJSON(CACHE_KEY, data); } catch (_) {}
  } catch (e) {
    errorMsg = (e && e.message) || '请求失败';
    try {
      const cached = ctx.storage.getJSON(CACHE_KEY);
      if (cached && cached.prices) { data = cached; mode = 'stale'; }
    } catch (_) {}
  }

  const prices = data ? data.prices : { p92: null, p95: null, p98: null, diesel: null };
  const regionName = data ? (data.regionName || '') : '';
  const trendInfo = (SHOW_TREND && data) ? (data.trendInfo || '') : '';

  const updDate = (mode === 'stale' && data && data.ts) ? new Date(data.ts) : now;
  const updStr = `${String(updDate.getHours()).padStart(2, '0')}:${String(updDate.getMinutes()).padStart(2, '0')}`;
  const updLabel = mode === 'stale' ? `缓存 ${updStr}` : `${updStr} 更新`;
  const statusColor = mode === 'live' ? C.ok : mode === 'stale' ? C.warn : C.bad;

  const rows = [
    { label: '92 号', price: prices.p92, color: C.p92 },
    { label: '95 号', price: prices.p95, color: C.p95 },
    { label: '98 号', price: prices.p98, color: C.p98 },
    { label: '柴油', price: prices.diesel, color: C.diesel },
  ].filter(r => r.price !== null);

  // ── 通用部件 ─────────────────────────────────────
  const headerRow = (titleSize) => ({
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      icon('fuelpump.fill', 13, C.p92),
      T(`${regionName || ''}油价`, titleSize, 'bold', C.text, { maxLines: 1, minScale: 0.7 }),
      { type: 'spacer' },
      dot(statusColor),
      T(updLabel, 'caption2', 'regular', C.dim, { maxLines: 1 }),
    ],
  });

  const priceCard = (row, priceSize, pad) => ({
    type: 'stack', direction: 'column', alignItems: 'center', flex: 1, gap: 4,
    padding: pad,
    backgroundColor: glass(), borderRadius: 12, borderWidth: 0.5, borderColor: glassBorder(),
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center',
        padding: [2, 8, 2, 8],
        backgroundColor: { light: `${row.color.light}26`, dark: `${row.color.dark}2E` },
        borderRadius: 6,
        children: [T(row.label, 'caption2', 'bold', row.color, { textAlign: 'center' })],
      },
      T(row.price.toFixed(2), priceSize, 'semibold', C.text, { textAlign: 'center', maxLines: 1, minScale: 0.7 }),
    ],
  });

  const emptyView = () => ({
    type: 'stack', direction: 'column', alignItems: 'center', flex: 1, gap: 5,
    padding: [14, 10, 14, 10],
    children: [
      icon('exclamationmark.triangle.fill', 22, C.bad),
      T('无法获取油价', 'body', 'medium', C.sub),
      T(errorMsg || '暂无数据', 'caption2', 'regular', C.dim, { maxLines: 1, minScale: 0.6 }),
    ],
  });

  // ── 锁屏小组件（布局与原版一致） ─────────────────
  if (ctx.widgetFamily && ctx.widgetFamily.startsWith('accessory')) {
    const SUB = { light: '#FFFFFFB3', dark: '#FFFFFFB3' };
    const short = (label) => label.replace(/\s/g, '');
    const place = regionName || '油价';

    let lockDate = '';
    const ldm = trendInfo.match(/(\d{1,2})月(\d{1,2})日/);
    if (ldm) lockDate = `${ldm[1].padStart(2, '0')}-${ldm[2].padStart(2, '0')}`;

    if (rows.length === 0) {
      return {
        type: 'widget', refreshAfter: refreshTime,
        children: [{
          type: 'text',
          text: `油价 ${errorMsg || '暂无数据'}`,
          font: { size: 'caption1', weight: 'medium' }, maxLines: 1, minScale: 0.5,
        }],
      };
    }

    // 单行：西安 92号 8.49 · 95号 8.97
    if (ctx.widgetFamily === 'accessoryInline') {
      return {
        type: 'widget', refreshAfter: refreshTime,
        children: [{
          type: 'text',
          text: `${place} ${rows.slice(0, 2).map(r => `${short(r.label)} ${r.price.toFixed(2)}`).join(' · ')}`,
          font: { size: 'caption1', weight: 'medium' }, maxLines: 1, minScale: 0.5,
        }],
      };
    }

    // 圆形：92 号价格
    if (ctx.widgetFamily === 'accessoryCircular') {
      const r0 = rows.find(r => r.label.includes('92')) || rows[0];
      return {
        type: 'widget', padding: 2, refreshAfter: refreshTime,
        children: [
          { type: 'spacer' },
          { type: 'text', text: short(r0.label), font: { size: 'caption2', weight: 'medium' }, textColor: SUB, textAlign: 'center', maxLines: 1 },
          { type: 'text', text: r0.price.toFixed(2), font: { size: 'headline', weight: 'bold' }, textAlign: 'center', maxLines: 1, minScale: 0.5 },
          { type: 'text', text: '元/升', font: { size: 'caption2' }, textColor: SUB, textAlign: 'center', maxLines: 1 },
          { type: 'spacer' },
        ],
      };
    }

    // 矩形：地区 + 调价日期，两行油品
    const cell = (r) => ({
      type: 'stack', direction: 'row', alignItems: 'center', flex: 1, gap: 4,
      children: [
        { type: 'text', text: short(r.label), font: { size: 'caption2', weight: 'medium' }, textColor: SUB, maxLines: 1 },
        { type: 'spacer' },
        { type: 'text', text: r.price.toFixed(2), font: { size: 'caption1', weight: 'bold' }, maxLines: 1, minScale: 0.6 },
      ],
    });
    const lockPairs = [];
    for (let i = 0; i < rows.length; i += 2) lockPairs.push(rows.slice(i, i + 2));

    return {
      type: 'widget', padding: 2, gap: 3, refreshAfter: refreshTime,
      children: [
        {
          type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
          children: [
            { type: 'image', src: 'sf-symbol:fuelpump.fill', width: 11, height: 11 },
            { type: 'text', text: place, font: { size: 'caption2', weight: 'semibold' }, maxLines: 1, minScale: 0.7 },
            { type: 'spacer' },
            ...(lockDate ? [{ type: 'text', text: lockDate, font: { size: 'caption2' }, textColor: SUB, maxLines: 1 }] : []),
          ],
        },
        ...lockPairs.map(pair => ({
          type: 'stack', direction: 'row', alignItems: 'center', gap: 10,
          children: pair.length === 1 ? [cell(pair[0]), { type: 'spacer' }] : pair.map(cell),
        })),
      ],
    };
  }

  // ── 小号小组件 ───────────────────────────────────
  if (ctx.widgetFamily === 'systemSmall') {
    const pairs = [];
    for (let i = 0; i < rows.length; i += 2) pairs.push(rows.slice(i, i + 2));

    return {
      type: 'widget',
      padding: [12, 12, 12, 12],
      gap: 6,
      backgroundGradient: bg(),
      refreshAfter: refreshTime,
      children: [
        headerRow('subheadline'),
        ...(trendInfo ? [T(trendInfo.replace(/\s+/g, ''), 'caption2', 'regular', C.sub, { maxLines: 1, minScale: 0.5 })] : []),
        rows.length > 0 ? {
          type: 'stack', direction: 'column', flex: 1, gap: 6,
          children: pairs.map(pair => ({
            type: 'stack', direction: 'row', gap: 6,
            children: pair.map(r => priceCard(r, 'headline', [6, 4, 6, 4])),
          })),
        } : emptyView(),
      ],
    };
  }

  // ── 中号小组件（默认） ───────────────────────────
  return {
    type: 'widget',
    padding: [12, 12, 12, 12],
    gap: 8,
    backgroundGradient: bg(),
    refreshAfter: refreshTime,
    children: [
      headerRow('subheadline'),
      rows.length > 0 ? {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 6, flex: 1,
        children: rows.map(r => priceCard(r, 'title3', [8, 4, 8, 4])),
      } : emptyView(),
      {
        type: 'stack', direction: 'row', alignItems: 'center',
        children: [
          trendInfo
            ? T(trendInfo.replace(/\s+/g, ' '), 'caption2', 'regular', C.sub, { maxLines: 1, minScale: 0.6 })
            : T(mode === 'error' ? errorMsg : '国内成品油价格', 'caption2', 'regular', mode === 'error' ? C.bad : C.dim, { maxLines: 1, minScale: 0.6 }),
          { type: 'spacer' },
          T('元/升', 'caption2', 'regular', C.dim, { maxLines: 1 }),
        ],
      },
    ],
  };
}
