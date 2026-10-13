/**
 * Egern 小组件：🛡️ 网络诊断雷达 · Hark 液态玻璃统一版 v1
 * UI 与「订阅流量监控 Hark 改版」统一风格
 *
 * 功能：
 *   - 本地网络：环境 / 网关 / 内网 / 公网 / 位置 / 直连延迟
 *   - 代理出口：IP / 落地 / 厂商 / 属性 / 纯净度 / 代理延迟
 *   - 流媒体与 AI 解锁检测：NF / DP / TK / GPT / CL / GM
 *   - 智能缓存：15 分钟 TTL + 网络环境锁 + IP 锁，切网自动重取
 *   - 状态点：绿=实时 黄=缓存或代理异常 红=获取失败
 *   - 支持中 / 小组件与锁屏组件（单行 / 圆形 / 矩形）
 *
 * Env：
 *   MASK_IP           IP 打码，默认 true（192.168.*.* / 2001:db8:****:****）
 *   REFRESH_MINUTES   刷新间隔（分钟，5~120），默认 15
 */

// ---------------------------------------------------------------------------
// 基础配置
// ---------------------------------------------------------------------------

let MASK_IP = true; // 由 Env 注入

const CACHE_KEY = 'egern.network.radar.v1';
const CACHE_TTL = 15 * 60 * 1000;

const BASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const commonHeaders = {
  'User-Agent': BASE_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache'
};

const LOCAL_DELAY_URLS = [
  'https://www.apple.com/library/test/success.html',
  'https://www.baidu.com/favicon.ico',
  'https://cdn.aliyun.com/favicon.ico',
  'https://www.qq.com/favicon.ico',
  'https://music.163.com/favicon.ico'
];

const PROXY_DELAY_URLS = [
  'https://api.ipify.org?format=json',
  'https://icanhazip.com',
  'https://v4.ident.me',
  'https://api.ip.sb/ip'
];

function safeParse(text) {
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function maskIPText(ip) {
  if (!ip || typeof ip !== 'string' || ip === '获取失败') return ip;
  if (!MASK_IP) return ip;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  } else if (ip.includes(':')) {
    const parts = ip.split(':');
    if (parts.length > 2) return `${parts[0]}:${parts[1]}:****:****`;
  }
  return ip;
}

function fmtIP(ip) {
  if (!ip || typeof ip !== 'string') return '获取失败';
  const masked = maskIPText(ip);
  if (masked.includes(':') && masked.length > 16 && !masked.includes('*')) {
    const parts = masked.split(':');
    return parts.length > 2 ? `${parts[0]}:${parts[1]}...${parts[parts.length - 1]}` : masked;
  }
  return masked;
}

function fmtProxyISP(isp) {
  if (!isp) return '未知';
  const s = String(isp);
  if (/it7/i.test(s)) return 'IT7 Network';
  if (/dmit/i.test(s)) return 'DMIT Network';
  if (/cloudflare/i.test(s)) return 'Cloudflare';
  if (/akamai/i.test(s)) return 'Akamai';
  if (/amazon|aws/i.test(s)) return 'AWS';
  if (/google/i.test(s)) return 'Google Cloud';
  if (/microsoft|azure/i.test(s)) return 'Azure';
  if (/alibaba|aliyun/i.test(s)) return '阿里云';
  if (/tencent/i.test(s)) return '腾讯云';
  if (/oracle/i.test(s)) return 'Oracle Cloud';
  if (/^\d+$/.test(s)) return `ASN: ${s}`;
  return s.length > 11 ? s.substring(0, 11) + '...' : s;
}

function getFlag(code) {
  if (!code) return '🏳️';
  if (code.toUpperCase() === 'TW') return '🇨🇳';
  if (code.toUpperCase() === 'XX' || code === 'OK') return '✅';
  return String.fromCodePoint(...code.toUpperCase().split('').map(c => 127397 + c.charCodeAt()));
}

async function readBody(r) {
  if (!r) return '';
  if (typeof r.body === 'string' && r.body.length) return r.body;
  if (typeof r.text === 'function') {
    try { const t = await r.text(); return typeof t === 'string' ? t : ''; } catch { return ''; }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 网络请求
// ---------------------------------------------------------------------------

async function fetchLocal(ctx) {
  try {
    const res = await ctx.http.get('https://myip.ipip.net/json', { headers: commonHeaders, timeout: 3500 });
    const body = safeParse(await res.text());
    if (body?.data?.ip) return { ip: body.data.ip, loc: `${body.data.location[1] || ''} ${body.data.location[2] || ''}`.trim() };
  } catch {}
  return { ip: '获取失败', loc: '未知' };
}

async function fetchProxyRawIP(ctx) {
  try {
    const res = await ctx.http.get('https://v4.ident.me', { timeout: 3000 });
    const ip = (await res.text())?.trim();
    return ip || null;
  } catch { return null; }
}

async function testDelay(ctx, urls, timeout = 2000) {
  for (const url of urls) {
    const start = Date.now();
    try {
      await ctx.http.get(url, { timeout });
      return `${Date.now() - start} ms`;
    } catch {}
  }
  return '超时';
}

// --- 解锁检测 ---

async function checkNetflix(ctx) {
  try {
    const checkStatus = async (id) => {
      const r = await ctx.http.get(`https://www.netflix.com/title/${id}`, { timeout: 3500, headers: commonHeaders, followRedirect: false }).catch(() => null);
      return r ? r.status : 0;
    };
    return (await checkStatus(81280792)) === 200 ? 'OK' : ((await checkStatus(70143836)) === 200 ? '🍿' : '❌');
  } catch { return '❌'; }
}

async function checkDisney(ctx) {
  try {
    const res = await ctx.http.get('https://www.disneyplus.com', { timeout: 3500, headers: commonHeaders, followRedirect: false }).catch(() => null);
    if (!res || res.status === 403) return '❌';
    return (res.headers?.location || res.headers?.Location || '').includes('unavailable') ? '❌' : 'OK';
  } catch { return '❌'; }
}

async function checkTikTok(ctx) {
  try {
    const r = await ctx.http.get('https://www.tiktok.com/explore', { timeout: 3500, headers: commonHeaders, followRedirect: false }).catch(() => null);
    if (!r || r.status === 403 || r.status === 401) return '❌';
    const body = await readBody(r);
    if (body.includes('Access Denied')) return '❌';
    const m = body.match(/"region":"([A-Z]{2})"/i);
    return m?.[1] ? m[1].toUpperCase() : 'OK';
  } catch { return '❌'; }
}

async function checkChatGPT(ctx) {
  try {
    const traceRes = await ctx.http.get('https://chatgpt.com/cdn-cgi/trace', { timeout: 3000 }).catch(() => null);
    const m = (await readBody(traceRes))?.match(/loc=([A-Z]{2})/);
    return m?.[1] ? m[1].toUpperCase() : 'OK';
  } catch { return '❌'; }
}

async function checkClaude(ctx) {
  try {
    const res = await ctx.http.get('https://claude.ai/login', { timeout: 4000, headers: commonHeaders }).catch(() => null);
    if (!res) return '❌';
    const body = await readBody(res);
    if (body.includes('App unavailable') || body.includes('certain regions')) return '❌';
    if (res.status === 403 && (body.includes('cf-turnstile') || body.includes('Just a moment'))) return '❌';
    return (res.status === 200 || res.status === 301 || res.status === 302) ? 'OK' : '❌';
  } catch { return '❌'; }
}

async function checkGemini(ctx) {
  try {
    const res = await ctx.http.get('https://gemini.google.com/app', { timeout: 3500, headers: commonHeaders, followRedirect: false }).catch(() => null);
    return (!res || (res.headers?.location || res.headers?.Location || '').includes('faq')) ? '❌' : 'OK';
  } catch { return '❌'; }
}

// ---------------------------------------------------------------------------
// 汉化字典
// ---------------------------------------------------------------------------

const ccMap = {
  'CN': '中国', 'HK': '香港', 'MO': '澳门', 'TW': '台湾', 'SG': '新加坡',
  'JP': '日本', 'KR': '韩国', 'MY': '马来西亚', 'TH': '泰国', 'VN': '越南',
  'PH': '菲律宾', 'ID': '印尼', 'IN': '印度', 'AU': '澳大利亚', 'NZ': '新西兰',
  'KH': '柬埔寨', 'LA': '老挝', 'MM': '缅甸', 'PK': '巴基斯坦', 'BD': '孟加拉',
  'LK': '斯里兰卡', 'KZ': '哈萨克斯坦', 'UZ': '乌兹别克斯坦', 'FJ': '斐济',
  'US': '美国', 'CA': '加拿大', 'MX': '墨西哥', 'BR': '巴西', 'AR': '阿根廷',
  'CL': '智利', 'CO': '哥伦比亚', 'PE': '秘鲁', 'UY': '乌拉圭', 'PA': '巴拿马',
  'UK': '英国', 'GB': '英国', 'DE': '德国', 'FR': '法国', 'NL': '荷兰',
  'RU': '俄罗斯', 'IT': '意大利', 'ES': '西班牙', 'CH': '瑞士', 'SE': '瑞典',
  'NO': '挪威', 'FI': '芬兰', 'DK': '丹麦', 'IE': '爱尔兰', 'BE': '比利时',
  'AT': '奥地利', 'PL': '波兰', 'CZ': '捷克', 'HU': '匈牙利', 'RO': '罗马尼亚',
  'UA': '乌克兰', 'TR': '土耳其', 'GR': '希腊', 'PT': '葡萄牙', 'BG': '保加利亚',
  'EE': '爱沙尼亚', 'LV': '拉脱维亚', 'LT': '立陶宛', 'LU': '卢森堡', 'IS': '冰岛',
  'SK': '斯洛伐克', 'SI': '斯洛文尼亚', 'HR': '克罗地亚', 'RS': '塞尔维亚', 'CY': '塞浦路斯',
  'AE': '阿联酋', 'SA': '沙特', 'IL': '以色列', 'ZA': '南非', 'EG': '埃及',
  'MA': '摩洛哥', 'KW': '科威特', 'QA': '卡塔尔', 'OM': '阿曼', 'BH': '巴林',
  'NG': '尼日利亚', 'KE': '肯尼亚', 'GH': '加纳', 'DZ': '阿尔及利亚'
};

const cityMap = {
  'tokyo': '东京', 'osaka': '大阪', 'nagoya': '名古屋', 'fukuoka': '福冈',
  'hong kong': '香港', 'hongkong': '香港', 'taipei': '台北', 'hsinchu': '新竹',
  'singapore': '新加坡', 'seoul': '首尔', 'incheon': '仁川', 'macau': '澳门',
  'bangkok': '曼谷', 'kuala lumpur': '吉隆坡', 'manila': '马尼拉', 'jakarta': '雅加达',
  'ho chi minh city': '胡志明市', 'hanoi': '河内', 'phnom penh': '金边',
  'mumbai': '孟买', 'bangalore': '班加罗尔', 'chennai': '金奈', 'new delhi': '新德里',
  'sydney': '悉尼', 'melbourne': '墨尔本', 'brisbane': '布里斯班', 'perth': '珀斯',
  'los angeles': '洛杉矶', 'san francisco': '旧金山', 'new york': '纽约',
  'seattle': '西雅图', 'sanjose': '圣何塞', 'san jose': '圣何塞', 'santa clara': '圣克拉拉',
  'chicago': '芝加哥', 'miami': '迈阿密', 'ashburn': '阿什本', 'oregon': '俄勒冈',
  'dallas': '达拉斯', 'atlanta': '亚特兰大', 'phoenix': '凤凰城', 'houston': '休斯敦',
  'denver': '丹佛', 'salt lake city': '盐湖城', 'las vegas': '拉斯维加斯', 'boston': '波士顿',
  'toronto': '多伦多', 'montreal': '蒙特利尔', 'vancouver': '温哥华', 'mexico city': '墨西哥城',
  'sao paulo': '圣保罗', 'rio de janeiro': '里约热内卢', 'buenos aires': '布宜诺斯艾利斯', 'santiago': '圣地亚哥',
  'frankfurt': '法兰克福', 'london': '伦敦', 'paris': '巴黎', 'amsterdam': '阿姆斯特丹',
  'manchester': '曼彻斯特', 'berlin': '柏林', 'munich': '慕尼黑', 'hamburg': '汉堡',
  'marseille': '马赛', 'milan': '米兰', 'rome': '罗马', 'madrid': '马德里', 'barcelona': '巴塞罗那',
  'zurich': '苏黎世', 'geneva': '日内瓦', 'stockholm': '斯德哥尔摩', 'oslo': '奥斯陆',
  'helsinki': '赫尔辛基', 'copenhagen': '哥本哈根', 'dublin': '都柏林', 'brussels': '布鲁塞尔',
  'vienna': '维也纳', 'warsaw': '华沙', 'prague': '布拉格', 'budapest': '布达佩斯',
  'moscow': '莫斯科', 'st petersburg': '圣彼得堡', 'saint petersburg': '圣彼得堡',
  'kiev': '基辅', 'kyiv': '基辅', 'istanbul': '伊斯坦布尔', 'lisbon': '里斯本',
  'dubai': '迪拜', 'abu dhabi': '阿布扎比', 'riyadh': '利雅得', 'jeddah': '吉达',
  'tel aviv': '特拉维夫', 'johannesburg': '约翰内斯堡', 'cape town': '开普敦', 'cairo': '开罗'
};

// ---------------------------------------------------------------------------
// 视觉：iOS 液态玻璃（与订阅流量监控统一）
// ---------------------------------------------------------------------------

const C = {
  text: { light: '#000000', dark: '#FFFFFF' },
  dim:  { light: '#3C3C4399', dark: '#EBEBF599' },
  glass: { light: '#FFFFFFA6', dark: '#FFFFFF1A' },
  line: { light: '#00000014', dark: '#FFFFFF24' },
  accent: '#0A84FF',
  local: '#0A84FF',
  proxy: '#BF5AF2',
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

function refreshAt(ctx) {
  const v = Number(ctx.env?.REFRESH_MINUTES);
  const m = Number.isFinite(v) && v > 0 ? Math.min(120, Math.max(5, v)) : 15;
  return new Date(Date.now() + m * 60000).toISOString();
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// 数据采集（双阶段 + 智能缓存）
// ---------------------------------------------------------------------------

async function loadRadar(ctx) {
  // 1. 本地网络环境
  const d = ctx.device || {};
  const isWifi = !!d.wifi?.ssid;
  let netName = '未连接', netIcon = 'antenna.radiowaves.left.and.right';

  const netInfo = (typeof $network !== 'undefined') ? $network : (ctx.network || {});
  const localIp = netInfo.v4?.primaryAddress || d.ipv4?.address || '获取失败';
  let gateway = netInfo.v4?.primaryRouter || d.ipv4?.gateway || '无网关';

  let networkLockKey = 'no_connection';
  if (isWifi) {
    netName = d.wifi.ssid;
    netIcon = 'wifi';
    networkLockKey = `wifi_${d.wifi.ssid}`;
  } else if (d.cellular?.radio) {
    const radioMap = { 'GPRS': '2.5G', 'EDGE': '2.75G', 'WCDMA': '3G', 'LTE': '4G', 'NR': '5G', 'NRNSA': '5G' };
    const cellType = radioMap[d.cellular.radio.toUpperCase().replace(/\s+/g, '')] || d.cellular.radio;
    netName = cellType;
    gateway = '蜂窝内网';
    networkLockKey = `cellular_${cellType}`;
  }

  // 2. 第一阶段：基础实时请求
  const [localData, proxyRawIP, localDelay, proxyDelay] = await Promise.all([
    fetchLocal(ctx),
    fetchProxyRawIP(ctx),
    testDelay(ctx, LOCAL_DELAY_URLS),
    testDelay(ctx, PROXY_DELAY_URLS),
  ]);

  // 3. 第二阶段：智能缓存调度
  const currentIP = proxyRawIP || '获取失败';
  let masterCache = null;
  try { masterCache = ctx.storage?.getJSON?.(CACHE_KEY) || null; } catch {}

  let finalProxy = null, finalPurity = null, finalUnlocks = null;
  let mode = 'live';
  let updatedAt = Date.now();

  const cacheValid = masterCache &&
    masterCache.ip === currentIP &&
    masterCache.networkLock === networkLockKey &&
    (Date.now() - masterCache.timestamp < CACHE_TTL) &&
    masterCache.proxyData &&
    masterCache.unlocks;

  if (cacheValid) {
    finalProxy = masterCache.proxyData;
    finalPurity = masterCache.purityData;
    finalUnlocks = masterCache.unlocks;
    mode = 'stale';
    updatedAt = masterCache.timestamp;
  } else {
    const fetchProxyFull = async () => {
      try { const res = await ctx.http.get(`https://ipapi.co/${currentIP}/json/`, { timeout: 4000 }); return safeParse(await res.text()); } catch { return {}; }
    };
    const fetchPurityFull = async () => {
      try { const res = await ctx.http.get('https://my.ippure.com/v1/info', { timeout: 4000 }); return safeParse(await res.text()); } catch { return {}; }
    };

    const [fullData, purData, rNF, rDP, rTK, rGPT, rCL, rGM] = await Promise.all([
      fetchProxyFull(), fetchPurityFull(),
      checkNetflix(ctx), checkDisney(ctx), checkTikTok(ctx),
      checkChatGPT(ctx), checkClaude(ctx), checkGemini(ctx),
    ]);

    const cc = fullData.country_code || 'XX';
    const cityName = fullData.city || '';
    const cnCountry = ccMap[cc.toUpperCase()] || fullData.country_name || '未知';
    const cnCity = cityMap[cityName.toLowerCase()] || cityName;
    const finalLocationString = (cnCountry === cnCity || cnCity === '') ? cnCountry : `${cnCountry} ${cnCity}`;

    finalProxy = {
      ip: fullData.ip || currentIP,
      loc: `${getFlag(cc)} ${finalLocationString}`.trim(),
      isp: fmtProxyISP(fullData.org || fullData.asn),
      cc: cc,
    };
    finalPurity = purData;
    finalUnlocks = { rNF, rDP, rTK, rGPT, rCL, rGM };

    if (currentIP !== '获取失败' && fullData.ip) {
      try {
        ctx.storage?.setJSON?.(CACHE_KEY, {
          ip: currentIP, networkLock: networkLockKey, timestamp: Date.now(),
          proxyData: finalProxy, purityData: finalPurity, unlocks: finalUnlocks,
        });
      } catch {}
    }
  }

  if (currentIP === '获取失败' && localData.ip === '获取失败') mode = 'error';

  return {
    mode, updatedAt,
    netName, netIcon, gateway, localIp, localData, localDelay,
    proxy: finalProxy, purity: finalPurity, unlocks: finalUnlocks, proxyDelay,
  };
}

// ---------------------------------------------------------------------------
// 布局
// ---------------------------------------------------------------------------

function statusOf(s) {
  const proxyFailed = !s.proxy || s.proxy.ip === '获取失败' || s.proxy.cc === 'XX';
  if (s.mode === 'error') return { color: C.fail, label: '获取失败' };
  if (s.mode === 'stale') return { color: C.warn, label: `缓存 ${fmtTime(s.updatedAt)}` };
  if (proxyFailed) return { color: C.warn, label: '代理异常' };
  return { color: C.ok, label: `${fmtTime(s.updatedAt)} 更新` };
}

function header(s) {
  const st = statusOf(s);
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      icon('waveform.path.ecg', C.accent, 13),
      T('网络诊断雷达', 13, C.text, 'semibold'),
      { type: 'spacer' },
      dot(st.color),
      T(st.label, 10, C.dim),
    ],
  };
}

function row(ic, icCol, label, val, valCol) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      icon(ic, icCol, 11),
      T(label, 10.5, C.dim, 'regular', { minScale: 0.85 }),
      { type: 'spacer' },
      T(val, 10.5, valCol || C.text, 'medium', { minScale: 0.75 }),
    ],
  };
}

function derive(s) {
  const isRes = s.purity?.isResidential;
  let nativeText = '未知属性', nativeIc = 'questionmark.building.fill', nativeCol = C.dim;
  if (isRes === true) { nativeText = '原生住宅'; nativeIc = 'house.fill'; nativeCol = C.ok; }
  else if (isRes === false) { nativeText = '商业机房'; nativeIc = 'building.2.fill'; nativeCol = C.warn; }

  const risk = s.purity?.fraudScore;
  let riskTxt = '无数据', riskCol = C.dim, riskIc = 'questionmark.circle.fill';
  if (risk !== undefined && risk !== null) {
    if (risk >= 70) { riskTxt = `高危 (${risk})`; riskCol = C.fail; riskIc = 'xmark.shield.fill'; }
    else if (risk >= 30) { riskTxt = `中危 (${risk})`; riskCol = C.warn; riskIc = 'exclamationmark.triangle.fill'; }
    else { riskTxt = `纯净 (${risk})`; riskCol = C.ok; riskIc = 'checkmark.shield.fill'; }
  }

  const proxyFailed = !s.proxy || s.proxy.ip === '获取失败' || s.proxy.cc === 'XX';
  const fmtUnlock = (name, res, cc) => {
    let flag = '🚫';
    if (res === '🍿') flag = res;
    else if (res !== '❌') flag = getFlag(res === 'OK' || res === 'XX' ? cc : res);
    return `${name} ${flag}`;
  };
  const u = s.unlocks || {};
  const cc = s.proxy?.cc || 'XX';
  const textVideo = proxyFailed ? 'NF —  DP —  TK —' : `${fmtUnlock('NF', u.rNF, cc)}  ${fmtUnlock('DP', u.rDP, cc)}  ${fmtUnlock('TK', u.rTK, cc)}`;
  const textAI = proxyFailed ? 'GPT —  CL —  GM —' : `${fmtUnlock('GPT', u.rGPT, cc)}  ${fmtUnlock('CL', u.rCL, cc)}  ${fmtUnlock('GM', u.rGM, cc)}`;

  return { nativeText, nativeIc, nativeCol, riskTxt, riskCol, riskIc, proxyFailed, textVideo, textAI };
}

/* ---------- 中号（默认） ---------- */

function mediumWidget(ctx, s) {
  const k = derive(s);
  return {
    type: 'widget', padding: [10, 12], gap: 8, backgroundGradient: bg(), refreshAfter: refreshAt(ctx),
    children: [
      header(s),
      glass([
        {
          type: 'stack', direction: 'row', gap: 10,
          children: [
            {
              type: 'stack', direction: 'column', gap: 4.5, flex: 1,
              children: [
                row(s.netIcon, C.local, '环境', s.netName),
                row('wifi.router.fill', C.local, '网关', s.gateway),
                row('iphone', C.local, '内网', fmtIP(s.localIp)),
                row('globe.asia.australia.fill', C.local, '公网', fmtIP(s.localData.ip)),
                row('map.fill', C.local, '位置', s.localData.loc),
                row('timer', C.local, '延迟', s.localDelay),
                row('play.tv.fill', C.local, '影视', k.textVideo),
              ],
            },
            { type: 'stack', width: 0.5, backgroundColor: C.line },
            {
              type: 'stack', direction: 'column', gap: 4.5, flex: 1,
              children: [
                row('paperplane.fill', C.proxy, '出口', fmtIP(s.proxy?.ip || '获取失败')),
                row('mappin.and.ellipse', C.proxy, '落地', s.proxy?.loc || '未知'),
                row('server.rack', C.proxy, '厂商', s.proxy?.isp || '未知'),
                row(k.nativeIc, k.nativeCol, '属性', k.nativeText),
                row(k.riskIc, k.riskCol, '纯净', k.riskTxt, k.riskCol),
                row('timer', C.proxy, '延迟', s.proxyDelay),
                row('cpu', C.proxy, 'AI', k.textAI),
              ],
            },
          ],
        },
      ], { padding: [10, 12] }),
      { type: 'spacer' },
    ],
  };
}

/* ---------- 小号 ---------- */

function smallWidget(ctx, s) {
  const k = derive(s);
  return {
    type: 'widget', padding: [12, 12], gap: 6, backgroundGradient: bg(), refreshAfter: refreshAt(ctx),
    children: [
      header(s),
      glass([
        row(s.netIcon, C.local, '环境', s.netName),
        row('globe.asia.australia.fill', C.local, '公网', fmtIP(s.localData.ip)),
        row('paperplane.fill', C.proxy, '出口', fmtIP(s.proxy?.ip || '获取失败')),
        row('mappin.and.ellipse', C.proxy, '落地', s.proxy?.loc || '未知'),
        row(k.riskIc, k.riskCol, '纯净', k.riskTxt, k.riskCol),
        row('timer', C.local, '延迟', `${s.localDelay} / ${s.proxyDelay}`),
      ], { padding: [10, 12], gap: 5 }),
      { type: 'spacer' },
    ],
  };
}

/* ---------- 锁屏 ---------- */

function lockWidget(ctx, s, family) {
  const k = derive(s);
  const SUB = { light: '#FFFFFFB3', dark: '#FFFFFFB3' };

  if (family === 'accessoryInline') {
    const text = k.proxyFailed
      ? `雷达 代理失败 · 本地 ${s.localDelay}`
      : `${s.proxy.loc.replace(/^(\S+)\s/, '')} ${fmtIP(s.proxy.ip)} · ${s.proxyDelay}`;
    return { type: 'widget', refreshAfter: refreshAt(ctx), children: [{ type: 'text', text, font: { size: 'caption1', weight: 'medium' }, maxLines: 1, minScale: 0.5 }] };
  }

  if (family === 'accessoryCircular') {
    const risk = s.purity?.fraudScore;
    return {
      type: 'widget', padding: 2, refreshAfter: refreshAt(ctx),
      children: [
        { type: 'spacer' },
        { type: 'text', text: '纯净', font: { size: 'caption2', weight: 'medium' }, textColor: SUB, textAlign: 'center', maxLines: 1 },
        { type: 'text', text: risk !== undefined && risk !== null ? String(risk) : '—', font: { size: 'headline', weight: 'bold' }, textAlign: 'center', maxLines: 1, minScale: 0.5 },
        { type: 'text', text: k.proxyFailed ? '代理失败' : k.nativeText, font: { size: 'caption2' }, textColor: SUB, textAlign: 'center', maxLines: 1 },
        { type: 'spacer' },
      ],
    };
  }

  const lockRow = (label, val) => ({
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
    children: [
      { type: 'text', text: label, font: { size: 'caption2', weight: 'medium' }, textColor: SUB, maxLines: 1 },
      { type: 'spacer' },
      { type: 'text', text: val, font: { size: 'caption1', weight: 'bold' }, maxLines: 1, minScale: 0.6 },
    ],
  });

  return {
    type: 'widget', padding: 2, gap: 3, refreshAfter: refreshAt(ctx),
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
        children: [
          { type: 'image', src: 'sf-symbol:waveform.path.ecg', width: 11, height: 11 },
          { type: 'text', text: '网络雷达', font: { size: 'caption2', weight: 'semibold' }, maxLines: 1 },
          { type: 'spacer' },
          { type: 'text', text: fmtTime(s.updatedAt), font: { size: 'caption2' }, textColor: SUB, maxLines: 1 },
        ],
      },
      lockRow('出口', k.proxyFailed ? '获取失败' : fmtIP(s.proxy.ip)),
      lockRow('落地', k.proxyFailed ? '—' : s.proxy.loc),
      lockRow('延迟', `本 ${s.localDelay} · 代 ${s.proxyDelay}`),
    ],
  };
}

// ---------------------------------------------------------------------------

export default async function (ctx) {
  MASK_IP = String((ctx.env || {}).MASK_IP ?? 'true') !== 'false';
  const family = ctx.widgetFamily || 'systemMedium';
  const s = await loadRadar(ctx);
  if (family.startsWith('accessory')) return lockWidget(ctx, s, family);
  if (family === 'systemSmall') return smallWidget(ctx, s);
  return mediumWidget(ctx, s);
}
