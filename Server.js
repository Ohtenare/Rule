/**
 * =================================================================
 * 🖥️ Server Monitor Widget Pro (Toggleable IP Masking)
 * =================================================================
 * * 📌 环境配置说明 (ctx.env):
 * -----------------------------------------------------------------
 * SERVER_HOST      : 服务器 IP 或 域名 (必填)
 * SERVER_USER      : SSH 用户名 (默认: root)
 * SERVER_PORT      : SSH 端口 (默认: 22)
 * SERVER_PASSWORD  : SSH 密码 (与 SERVER_KEY 二选一)
 * SERVER_KEY       : SSH 私钥 (支持 OpenSSH/PEM 格式，自动修复换行符)
 * WIDGET_NAME      : 小组件显示的名称 (可选)
 * MASK_IP          : 是否开启 IP 打码 (true/false, 默认: false)
 * * 📊 流量统计配置 (二选一):
 * -----------------------------------------------------------------
 * 方案 A (搬瓦工 API):
 * BWH_VEID         : 搬瓦工 VEID
 * BWH_API_KEY      : 搬瓦工 API KEY
 * * 方案 B (自定义设置):
 * TRAFFIC_LIMIT    : 每月流量上限，单位 GB (默认: 2000)
 * RESET_DAY        : 每月流量重置日期 (默认: 1)
 * =================================================================
 */

export default async function (ctx) {
  const env = ctx.env || {}; 
  
  const SERVER_CONFIG = {
    widgetName: env.WIDGET_NAME || 'My Node',        
    host: env.SERVER_HOST || '',                     
    port: Number(env.SERVER_PORT) || 22,             
    username: env.SERVER_USER || 'root',             
    password: env.SERVER_PASSWORD || '',             
    privateKey: env.SERVER_KEY || '',                
    maskIp: String(env.MASK_IP).toLowerCase() === 'true', // 核心开关
    bwhVeid: env.BWH_VEID || '',                     
    bwhApiKey: env.BWH_API_KEY || '',                
    trafficLimitGB: Number(env.TRAFFIC_LIMIT) || 2000, 
    resetDay: Number(env.RESET_DAY) || 1             
  };

  // 🎨 UI 规范颜色
  const C = {
    bg: { light: '#FFFFFF', dark: '#121212' },       
    barBg: { light: '#0000001A', dark: '#FFFFFF22' },
    text: { light: '#1C1C1E', dark: '#FFFFFF' },     
    dim: { light: '#8E8E93', dark: '#8E8E93' },      
    cpu: { light: '#007AFF', dark: '#0A84FF' },      
    mem: { light: '#AF52DE', dark: '#BF5AF2' },      
    traffic: (pct) => pct >= 85 ? { light: '#FF3B30', dark: '#FF453A' } : (pct >= 60 ? { light: '#FF9500', dark: '#FF9F0A' } : { light: '#34C759', dark: '#30D158' })
  };

  const fmtBytes = (b) => {
    if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + 'T';
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + 'G';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + 'M';
    if (b >= 1024)      return (b / 1024).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  // 🔒 可选 IP 打码逻辑
  const processIP = (ip) => {
    if (!ip) return 'Unknown';
    if (!SERVER_CONFIG.maskIp) return ip; // 如果未开启打码，直接返回原 IP
    
    if (ip.includes('.')) { // IPv4
      const p = ip.split('.');
      return p.length === 4 ? `${p[0]}.${p[1]}.*.*` : ip;
    }
    if (ip.includes(':')) { // IPv6
      const p = ip.split(':');
      return `${p[0]}:${p[1]}:****:****`;
    }
    return ip;
  };

  const getNextResetDate = (resetDay) => {
    const now = new Date();
    let y = now.getFullYear(), m = now.getMonth();
    if (now.getDate() >= resetDay) m += 1; 
    if (m > 11) { m = 0; y += 1; }
    return `${m + 1}/${resetDay}`;
  };

  let d;
  try {
    const { host, port, username, password, privateKey, widgetName, bwhVeid, bwhApiKey, trafficLimitGB, resetDay } = SERVER_CONFIG;
    if (!host) throw new Error('未配置 SERVER_HOST');

    // 🛠️ 私钥格式修复逻辑
    let finalKey = privateKey;
    if (privateKey && typeof privateKey === 'string') {
        const raw = privateKey.trim();
        const headerMatch = raw.match(/-----BEGIN [A-Z ]+-----/);
        const footerMatch = raw.match(/-----END [A-Z ]+-----/);
        if (headerMatch && footerMatch) {
            const header = headerMatch[0], footer = footerMatch[0];
            let body = raw.substring(raw.indexOf(header) + header.length, raw.indexOf(footer)).replace(/\s+/g, '');
            const lines = body.match(/.{1,64}/g) || [];
            finalKey = `${header}\n${lines.join('\n')}\n${footer}`;
        } else {
            finalKey = raw.replace(/\\n/g, '\n');
        }
    }

    let bwhData = null;
    if (bwhVeid && bwhApiKey) {
      try {
        const resp = await ctx.http.get(`https://api.64clouds.com/v1/getServiceInfo?veid=${bwhVeid}&api_key=${bwhApiKey}`);
        bwhData = await resp.json();
      } catch (e) { console.log('BWH API Error'); }
    }

    const session = await ctx.ssh.connect({
      host, port: Number(port || 22), username,
      ...(finalKey ? { privateKey: finalKey } : { password }),
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
      "curl -s -m 2 http://ip-api.com/line?fields=query || echo ''",
      "awk '/^ *(eth|en|wlan|ens|eno|bond|veth)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev",
    ];
    const { stdout } = await session.exec(cmds.join(` && echo '${SEP}' && `));
    await session.close();

    const p = stdout.split(SEP).map(s => s.trim());
    const hostname = widgetName !== 'My Node' ? widgetName : (p[0] || 'Server');
    const load = (p[1] || '0 0 0').split(' ').slice(0, 3);
    const upSec = parseFloat((p[2] || '0').split(' ')[0]);
    const uptime = Math.floor(upSec / 86400) > 0 ? `${Math.floor(upSec / 86400)}d ${Math.floor((upSec % 86400) / 3600)}h` : `${Math.floor(upSec / 3600)}h ${Math.floor((upSec % 3600) / 60)}m`;

    const cpuNums = (p[3] || '').replace(/^cpu\s+/, '').split(/\s+/).map(Number);
    const cpuTotal = cpuNums.reduce((a, b) => a + b, 0), cpuIdle = cpuNums[3] || 0;
    const prevCpu = ctx.storage.getJSON('_cpu');
    let cpuPct = 0;
    if (prevCpu && cpuTotal > prevCpu.t) cpuPct = Math.round(((cpuTotal - prevCpu.t - (cpuIdle - prevCpu.i)) / (cpuTotal - prevCpu.t)) * 100);
    ctx.storage.setJSON('_cpu', { t: cpuTotal, i: cpuIdle });

    const memKB = (p[4] || '0 0 0 0').split(' ').map(Number);
    const memTotal = memKB[0] * 1024 || 1, memUsed = (memKB[0] - memKB[1] - memKB[2] - memKB[3]) * 1024;
    const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));

    const cores = parseInt(p[6]) || 1;
    const rawIp = p[7] || host;
    const ipInfo = processIP(rawIp); // 应用打码开关

    const nn = (p[8] || '0 0').split(' ');
    const netRx = Number(nn[0]) || 0, netTx = Number(nn[1]) || 0;
    const prevNet = ctx.storage.getJSON('_net'), now = Date.now();
    ctx.storage.setJSON('_net', { rx: netRx, tx: netTx, ts: now });

    let tfUsed = netRx + netTx, tfTotal = trafficLimitGB * (1024 ** 3), tfReset = getNextResetDate(resetDay);
    if (bwhData && bwhData.data_counter !== undefined) {
      tfUsed = bwhData.data_counter;
      tfTotal = bwhData.plan_monthly_data;
      const rd = new Date((bwhData.data_next_reset || 0) * 1000);
      tfReset = `${rd.getMonth() + 1}/${rd.getDate()}`;
    }
    const tfPct = Math.min((tfUsed / tfTotal) * 100, 100);
    const timeStr = `${String(new Date().getHours()).padStart(2, '0')}:${String(new Date().getMinutes()).padStart(2, '0')}`;

    d = { hostname, uptime, cpuPct: Math.max(0, cpuPct), cores, memTotal, memUsed, memPct, tfUsed, tfTotal, tfPct, tfReset, timeStr, ipInfo };
  } catch (e) {
    d = { error: String(e.message || e) };
  }

  // --- UI Components ---
  const bar = (pct, color, h = 6) => {
    const segCount = 24, activeCount = Math.round((Math.max(0, Math.min(100, pct)) / 100) * segCount);
    return {
      type: 'stack', direction: 'row', height: h, gap: 1.5,
      children: Array.from({ length: segCount }).map((_, i) => ({
        type: 'stack', flex: 1, height: h, borderRadius: 1,
        backgroundColor: i < activeCount ? color : C.barBg,
        opacity: i < activeCount ? (0.4 + 0.6 * (i / Math.max(activeCount - 1, 1))) : 1
      }))
    };
  };

  if (d.error) return { type: 'widget', padding: 16, backgroundColor: C.bg, children: [{ type: 'text', text: '⚠️ Connection Error', font: { weight: 'bold' }, textColor: '#FF3B30' }, { type: 'text', text: d.error, font: { size: 10 }, textColor: C.dim }] };

  const commonItems = [
    { lb: 'CPU', pt: d.cpuPct, v: `${d.cpuPct}%`, c: C.cpu },
    { lb: 'MEM', pt: d.memPct, v: `${fmtBytes(d.memUsed)}`, c: C.mem },
    { lb: 'TRAF', pt: d.tfPct, v: `${d.tfPct.toFixed(1)}%`, c: C.traffic(d.tfPct) }
  ];

  if (ctx.widgetFamily === 'systemSmall') {
    return {
      type: 'widget', backgroundColor: C.bg, padding: 12, gap: 6,
      children: [
        { type: 'stack', direction: 'column', children: [
          { type: 'text', text: d.hostname, font: { size: 13, weight: 'bold' }, textColor: C.text, maxLines: 1 },
          { type: 'text', text: d.ipInfo, font: { size: 10, family: 'Menlo', weight: 'bold' }, textColor: C.dim },
        ]},
        ...commonItems.map(i => ({
          type: 'stack', direction: 'column', gap: 2, children: [
            { type: 'stack', direction: 'row', children: [
              { type: 'text', text: i.lb, font: { size: 9, weight: 'bold' }, textColor: C.text },
              { type: 'spacer' },
              { type: 'text', text: i.v, font: { size: 9, family: 'Menlo' }, textColor: i.c },
            ]},
            bar(i.pt, i.c, 4),
          ]
        }))
      ]
    };
  }

  return {
    type: 'widget', backgroundColor: C.bg, padding: 16, gap: 10,
    children: [
      { type: 'stack', direction: 'row', alignItems: 'center', children: [
        { type: 'text', text: d.hostname, font: { size: 16, weight: 'bold' }, textColor: C.text },
        { type: 'spacer' },
        { type: 'text', text: d.uptime, font: { size: 11 }, textColor: C.dim },
      ]},
      { type: 'stack', direction: 'row', children: [
        { type: 'text', text: 'SERVER IP', font: { size: 10, weight: 'bold' }, textColor: C.dim },
        { type: 'spacer' },
        { type: 'text', text: d.ipInfo, font: { size: 11, family: 'Menlo', weight: 'bold' }, textColor: C.text },
      ]},
      ...commonItems.map(i => ({
        type: 'stack', direction: 'column', gap: 4, children: [
          { type: 'stack', direction: 'row', children: [
            { type: 'text', text: i.lb, font: { size: 11, weight: 'bold' }, textColor: C.text },
            { type: 'spacer' },
            { type: 'text', text: i.lb === 'MEM' ? `${i.v} / ${fmtBytes(d.memTotal)}` : (i.lb === 'TRAF' ? `${fmtBytes(d.tfUsed)} / ${fmtBytes(d.tfTotal)}` : i.v), font: { size: 10, family: 'Menlo' }, textColor: i.c },
          ]},
          bar(i.pt, i.c, 6),
        ]
      })),
      { type: 'stack', direction: 'row', children: [
        { type: 'text', text: `Updated: ${d.timeStr}`, font: { size: 9 }, textColor: C.dim },
        { type: 'spacer' },
        { type: 'text', text: `Reset: ${d.tfReset}`, font: { size: 9 }, textColor: C.dim },
      ]}
    ]
  };
}
