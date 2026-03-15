/**
 * ⛽ 全国实时油价小组件
 * 数据源：http://m.qiyoujiage.com/
 * 脚本作者：Egern 群友 tg://user?id=5122789128
 * 由 iBL3ND 二次修改
 * 
 * 🔧 功能特性：
 * - 支持全国所有省份和城市
 * - 标题自动显示当前填写的地区
 * - 实时显示 92/95/98 号汽油和柴油价格
 * - 深色模式自动适配
 * - 全 iPhone 机型适配
 * 
 * 📚 使用教程
 * ═══════════════════════════════════════════════════
 *
 * 1️⃣ 环境变量配置
 * ─────────────────────────────────────────────────
 * 在 Egern 小组件配置中添加：
 *
 * 名称：region
 * 值：省份/城市（拼音，用 / 分隔）
 *
 * 名称：SHOW_TREND
 * 值：true（显示调价趋势）或 false（不显示）
 *
 * 2️⃣ 地区代码对照表
 * ─────────────────────────────────────────────────
 * 【直辖市】
 * • 北京：beijing  • 上海：shanghai
 * • 天津：tianjin  • 重庆：chongqing
 * 【省份 - 省会城市】
 * • 广东：guangdong/guangzhou
 * • 江苏：jiangsu/nanjing
 * • 浙江：zhejiang/hangzhou
 * • 山东：shandong/jinan
 * • 河南：henan/zhengzhou
 * • 河北：hebei/shijiazhuang
 * • 四川：sichuan/chengdu
 * • 湖北：hubei/wuhan
 * • 湖南：hunan/changsha
 * • 安徽：anhui/hefei
 * • 福建：fujian/fuzhou
 * • 江西：jiangxi/nanchang
 * • 辽宁：liaoning/shenyang
 * • 陕西：shanxi-3/xian  ⚠️
 * • 海南：hainan/haikou
 * • 山西：shanxi-1/taiyuan  ⚠️
 * • 吉林：jilin/changchun
 * • 黑龙江：heilongjiang/haerbin
 * • 云南：yunnan/kunming
 * • 贵州：guizhou/guiyang
 * • 广西：guangxi/nanning
 * • 甘肃：gansu/lanzhou
 * • 青海：qinghai/xining
 * • 宁夏：ningxia/yinchuan
 * • 新疆：xinjiang/wulumuqi
 * • 西藏：xizang/lasa
 * • 内蒙古：neimenggu/huhehaote
 * • 也可以去 http://m.qiyoujiage.com/shanxi-3.shtml 查看自己省份拼音
 * ═══════════════════════════════════════════════════
 */

export default async function (ctx) {
  const regionParam = ctx.env.region || "hainan/haikou";
  const SHOW_TREND = (ctx.env.SHOW_TREND || "true").trim() !== "false";

  const now = new Date();
  const currYear = now.getFullYear();
  const timeStr = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  const refreshTime = new Date(Date.now() + 6*60*60*1000).toISOString();

  const backgroundColor = { light: "#FFFFFF", dark: "#1C1C1E" };
  const COLORS = {
    primary: { light: "#1A1A1A", dark: "#FFFFFF" },
    secondary: { light: "#666666", dark: "#CCCCCC" },
    tertiary: { light: "#999999", dark: "#888888" },
    card: { light: "#F5F5F7", dark: "#2C2C2E" },
    cardBorder: { light: "#E0E0E0", dark: "#3A3A3C" },
    p92: { light: "#FF9F0A", dark: "#FFB347" },
    p95: { light: "#FF6B35", dark: "#FF8A5C" },
    p98: { light: "#FF3B30", dark: "#FF6B6B" },
    diesel: { light: "#30D158", dark: "#5CD67D" },
    trend: { light: "#2C2C2E", dark: "#FFFFFF" },
    urgent: { light: "#FF3B30", dark: "#FF453A" } 
  };

  // --- 📅 调价倒计时逻辑 ---
  const CALENDAR_2026 = [
    {m: 1, d: 12}, {m: 1, d: 23}, {m: 2, d: 9},  {m: 2, d: 23}, {m: 3, d: 9},  {m: 3, d: 23}, {m: 4, d: 7},  {m: 4, d: 21}, 
    {m: 5, d: 8},  {m: 5, d: 22}, {m: 6, d: 5},  {m: 6, d: 19}, {m: 7, d: 3},  {m: 7, d: 17}, {m: 7, d: 31}, {m: 8, d: 14}, 
    {m: 8, d: 28}, {m: 9, d: 11}, {m: 9, d: 25}, {m: 10, d: 14}, {m: 10, d: 28}, {m: 11, d: 11}, {m: 11, d: 25}, {m: 12, d: 9}, {m: 12, d: 23}
  ];

  const getNextAdjust = () => {
    for (const item of CALENDAR_2026) {
      const target = new Date(currYear, item.m - 1, item.d, 23, 59, 59);
      if (target > now) {
        const diffMs = target - now;
        const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
        const days = Math.floor(totalHours / 24);
        return { 
          text: `下轮调价: ${item.m}月${item.d}日 (${days}天后)`, 
          isUrgent: totalHours < 72 
        };
      }
    }
    return { text: "下轮调价: 待更新", isUrgent: false };
  };
  const nextAdjust = getNextAdjust();

  // --- 📡 数据获取 ---
  const CACHE_KEY = `qiyoujiage_oil_v6_${regionParam}`;
  let prices = {p92:null, p95:null, p98:null, diesel:null};
  let regionName = "";
  let trendInfo = "";
  let hasCache = false;
  
  try {
    const cached = ctx.storage.getJSON(CACHE_KEY);
    if (cached) {
      prices = cached.prices; regionName = cached.regionName; trendInfo = cached.trendInfo; hasCache = true;
    }
  } catch(_){}

  try {
    const resp = await ctx.http.get(`http://m.qiyoujiage.com/${regionParam}.shtml`, { timeout: 10000 });
    if (resp.status === 200) {
      const html = await resp.text();
      const titleMatch = html.match(/<title>([^_]+)_/);
      if (titleMatch) regionName = titleMatch[1].trim().replace(/(油价|实时|今日|最新|查询|价格)/g, '').trim();

      const regPrice = /<dl>[\s\S]+?<dt>(.*油)<\/dt>[\s\S]+?<dd>(.*)\(元\)<\/dd>/gm;
      let m;
      while ((m = regPrice.exec(html)) !== null) {
        const val = parseFloat(m[2]);
        if (m[1].includes("92")) prices.p92 = val;
        else if (m[1].includes("95")) prices.p95 = val;
        else if (m[1].includes("98")) prices.p98 = val;
        else if (m[1].includes("柴") || m[1].includes("0")) prices.diesel = val;
      }

      if (SHOW_TREND) {
        const trendMatch = html.match(/<div class="tishi">[\s\S]*?<span>([\s\S]+?)<\/span>[\s\S]*?<br\/>([\s\S]+?)<br\/>/);
        if (trendMatch) {
          const fullDate = trendMatch[1].match(/(\d{1,2}月\d{1,2}日\d{1,2}时)/)?.[1] || trendMatch[1].match(/(\d{1,2}月\d{1,2}日)/)?.[1] || "";
          const isUp = trendMatch[2].includes("上调");
          const amountMatch = trendMatch[2].match(/[\d\.]+\s*元\/升/g);
          
          let amount = amountMatch ? (amountMatch.length >= 2 ? `${amountMatch[0].replace('元/升','')}-${amountMatch[1].replace('元/升','')}` : amountMatch[0].replace('元/升','')) : "";
          
          trendInfo = `${fullDate} ${isUp?'↑':'↓'} ${amount}元/L`;
        }
      }
      ctx.storage.setJSON(CACHE_KEY, { prices, regionName, trendInfo });
    }
  } catch (e) {}

  const rows = [
    {label:"92 号", price:prices.p92, color:COLORS.p92},
    {label:"95 号", price:prices.p95, color:COLORS.p95},
    {label:"98 号", price:prices.p98, color:COLORS.p98},
    {label:"柴油", price:prices.diesel, color:COLORS.diesel},
  ].filter(r => r.price);

  function priceCard(row){
    return {
      type:"stack", direction:"column", alignItems:"center", flex:1, padding:[8,0],
      backgroundColor: COLORS.card, borderRadius:12, borderWidth: 0.5, borderColor: COLORS.cardBorder,
      children:[
        {
          type:"stack", padding:[2,6], backgroundColor: { light: row.color.light + "20", dark: row.color.dark + "20" },
          borderRadius:6, children:[{ type:"text", text:row.label, font:{size:10,weight:"bold"}, textColor: row.color }]
        },
        { type:"text", text:row.price.toFixed(2), font:{size:18,weight:"semibold"}, textColor: COLORS.primary, padding:[4,0,0,0] }
      ]
    }
  }

  return {
    type:"widget", padding:12, backgroundColor: backgroundColor, refreshAfter:refreshTime,
    children:[
      {
        type:"stack", direction:"row", alignItems:"center",
        children:[
          {type:"image", src:"sf-symbol:fuelpump.fill", width:14, height:14, color:COLORS.p92},
          // 🔹 标题修改为：XX实时油价
          {type:"text", text:`${regionName||'地区'}实时油价`, font:{size:13,weight:"bold"}, textColor:COLORS.primary, padding:[0,4]},
          {type:"spacer"},
          ...(SHOW_TREND && trendInfo ? [{
            type:"text", text: trendInfo, font:{size:11}, textColor: COLORS.trend
          }] : [])
        ]
      },
      {type:"spacer", length:10},
      {
        type:"stack", direction:"row", gap:8,
        children: rows.length > 0 ? rows.map(priceCard) : [{type:"text", text:"数据加载中...", textColor:COLORS.tertiary}]
      },
      {type:"spacer", length:10},
      {
        type:"stack", direction:"row", alignItems:"center",
        children:[
          {type:"text", text:`${timeStr} 更新`, font:{size:11}, textColor:COLORS.tertiary},
          {type:"spacer"},
          {
            type:"text", 
            text: nextAdjust.text, 
            font:{size:11}, 
            textColor: nextAdjust.isUrgent ? COLORS.urgent : COLORS.tertiary 
          }
        ]
      }
    ]
  };
}
