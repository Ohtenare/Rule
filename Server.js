/**
 * =================================================================
 * 🖥️ Server Monitor Widget Pro (Private Key Auto-Fix Edition)
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
    maskIp: String(env.MASK_IP).toLowerCase() === 'true', // 新增：打码开关配置
    bwhVeid: env.BWH_VEID || '',                     
    bwhApiKey: env.BWH_API_KEY || '',                
    trafficLimitGB: Number(env.TRAFFIC_LIMIT) || 2000, 
    resetDay: Number(env.RESET_DAY) || 1             
  };

  // 🎨 统一 UI 规范颜色
  const C = {
    bg: { light: '#FFFFFF', dark: '#121212' },       
    barBg: { light: '#0000001A', dark: '#FFFFFF22' },
    text: { light: '#1C1C1E', dark: '#FFFFFF' },     
    dim: { light: '#8E8E93', dark: '#8E8E93' },      
    
    cpu: { light: '#007AFF', dark: '#0A84FF' },      
    mem: { light: '#AF52DE', dark: '#BF5AF2' },      
    disk: { light: '#FF9500', dark: '#FF9F0A' },     
    netRx: { light: '#34C759', dark: '#30D158' },    
    netTx: { light: '#5856D6', dark: '#5E5CE6' },    
  };

  const getTrafficColor = (pct) => {
    if (pct >= 85) return { light: '#FF3B30', dark: '#FF453A' }; 
    if (pct >= 60) return { light: '#FF9500', dark: '#FF9F0A' }; 
    return { light: '#34C759', dark: '#30D158' };                
  };

  const fmtBytes = (b) => {
    if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + 'T';
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + 'G';
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(1) + 'M';
    if (b >= 1024)      return (b / 1024).toFixed(0) + 'K';
    return Math.round(b) + 'B';
  };

  // 🔒 新增：IP 打码处理逻辑
  const processIP = (ip) => {
    if (!ip || !SERVER_CONFIG.maskIp) return ip;
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
    return `${m + 1}月${resetDay}日 00:00`;
  };

  let d;
  try {
    const { host, port, username, password, privateKey, widgetName, bwhVeid, bwhApiKey, trafficLimitGB, resetDay } = SERVER_CONFIG;
    
    if (!host) {
      throw new Error('未配置 SERVER_HOST 环境变量');
    }

    // 🛠️ 移植核心修复：处理私钥格式及换行符问题
    let finalKey = privateKey;
    if (privateKey && typeof privateKey === 'string') {
        const raw = privateKey.trim();
        const headerMatch = raw.match(/-----BEGIN [A-Z ]+-----/);
        const footerMatch = raw.match(/-----END [A-Z ]+-----/);
        
        if (headerMatch && footerMatch) {
            const header = headerMatch[0];
            const footer = footerMatch[0];
            let body = raw.substring(raw.indexOf(header) + header.length, raw.indexOf(footer));
            body = body.replace(/\s+/g, '');
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
      } catch (e) { console.log('BWH API Error:', e); }
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
      "curl -s -m 2 http://ip-api.com/line?fields=country,city,query || echo ''",
      "awk '/^ *(eth|en|wlan|ens|eno|bond|veth)/{rx+=$2;tx+=$10}END{print rx,tx}' /proc/net/dev",
    ];
    const { stdout } = await session.exec(cmds.join(` && echo '${SEP}' && `));
    await session.close();

    const p = stdout.split(SEP).map(s => s.trim());
    const hostname = widgetName !== 'My Node' ? widgetName : (p[0] || 'Server');
    const load = (p[1] || '0 0 0').split(' ').slice(0, 3);
    
    const upSec = parseFloat((p[2] || '0').split(' ')[0]);
    const upDays = Math.floor(upSec / 86400);
    const upHours = Math.floor((upSec % 86400) / 3600);
    const upMins = Math.floor((upSec % 3600) / 60);
    const uptime = upDays > 0 ? `${upDays}天 ${upHours}小时` : `${upHours}小时 ${upMins}分`;

    const cpuNums = (p[3] || '').replace(/^cpu\s+/, '').split(/\s+/).map(Number);
    const cpuTotal = cpuNums.reduce((a, b) => a + b, 0);
    const cpuIdle = cpuNums[3] || 0;
    const prevCpu = ctx.storage.getJSON('_cpu');
    let cpuPct = 0;
    if (prevCpu && cpuTotal > prevCpu.t) {
      cpuPct = Math.round(((cpuTotal - prevCpu.t - (cpuIdle - prevCpu.i)) / (cpuTotal - prevCpu.t)) * 100);
    }
    ctx.storage.setJSON('_cpu', { t: cpuTotal, i: cpuIdle });
    cpuPct = Math.max(0, Math.min(100, cpuPct));
    
    const memKB = (p[4] || '0 0 0 0').split(' ').map(Number);
    const memTotal = memKB[0] * 1024 || 1;
    const memFree = memKB[1] * 1024 || 0;
    const memBuff = memKB[2] * 1024 || 0;
    const memCache = memKB[3] * 1024 || 0;
    const memUsed = memTotal - memFree - memBuff - memCache;
    const memPct = Math.min(100, Math.round((memUsed / memTotal) * 100));

    const df = (p[5] || '').split(/\s+/);
    const diskTotal = Number(df[1]) || 1, diskUsed = Number(df[2]) || 0;
    const diskPct = parseInt(df[4]) || 0;
    const cores = parseInt(p[6]) || 1;

    let ipInfo = processIP(host); // 应用打码
    let locInfo = '未知';
    const ipApiLines = (p[7] || '').split('\n').map(s => s.trim()).filter(Boolean);
    if (ipApiLines.length >= 3) {
      locInfo = `${ipApiLines[0]} ${ipApiLines[1]}`.replace(/United States/g, 'US').replace(/United Kingdom/g, 'UK');
      ipInfo = processIP(ipApiLines[2]); // 应用打码
    }

    const nn = (p[8] || '0 0').split(' ');
    const netRx = Number(nn[0]) || 0, netTx = Number(nn[1]) || 0;
    const prevNet = ctx.storage.getJSON('_net');
    const now = Date.now();
    let rxRate = 0, txRate = 0;
    if (prevNet && prevNet.ts) {
      const el = (now - prevNet.ts) / 1000;
      if (el > 0 && el < 3600) {
        rxRate = Math.max(0, (netRx - prevNet.rx) / el);
        txRate = Math.max(0, (netTx - prevNet.tx) / el);
      }
    }
    ctx.storage.setJSON('_net', { rx: netRx, tx: netTx, ts: now });

    let tfUsed = 0, tfTotal = 1, tfPct = 0, tfReset = '';
    if (bwhData && bwhData.data_counter !== undefined) {
      tfUsed = bwhData.data_counter;
      tfTotal = bwhData.plan_monthly_data;
      tfPct = Math.min((tfUsed / tfTotal) * 100, 100) || 0;
      const rd = new Date((bwhData.data_next_reset || 0) * 1000);
      tfReset = `${rd.getMonth() + 1}月${rd.getDate()}日 ${String(rd.getHours()).padStart(2, '0')}:${String(rd.getMinutes()).padStart(2, '0')}`;
      if (bwhData.ip_addresses && bwhData.ip_addresses[0]) ipInfo = processIP(bwhData.ip_addresses[0]); // 应用打码
      if (bwhData.node_location) locInfo = bwhData.node_location;
    } else {
      tfUsed = netRx + netTx;
      tfTotal = trafficLimitGB * (1024 ** 3);
      tfPct = Math.min((tfUsed / tfTotal) * 100, 100) || 0;
      tfReset = getNextResetDate(resetDay);
    }

    const dNow = new Date();
    const timeStr = `${String(dNow.getHours()).padStart(2, '0')}:${String(dNow.getMinutes()).padStart(2, '0')}:${String(dNow.getSeconds()).padStart(2, '0')}`;

    d = {
      hostname, uptime, load, cpuPct, cores,
      memTotal, memUsed, memPct, diskTotal, diskUsed, diskPct,
      rxRate, txRate, netRx, netTx,
      tfUsed, tfTotal, tfPct, tfReset, timeStr, ipInfo, locInfo
    };
  } catch (e) {
    d = { error: String(e.message || e) };
  }

  // 🛠️ 进度条渲染函数
  const bar = (pct, color, h = 6) => {
    const segCount = 24; 
    const activeCount = Math.round((Math.max(0, Math.min(100, pct)) / 100) * segCount);
    return {
      type: 'stack', direction: 'row', height: h, gap: 1.5,
      children: Array.from({ length: segCount }).map((_, i) => {
        const isActive = i < activeCount;
        const op = isActive ? (0.4 + 0.6 * (i / Math.max(activeCount - 1, 1))) : 1;
        return {
          type: 'stack', flex: 1, height: h, borderRadius: 1,
          backgroundColor: isActive ? color : C.barBg,
          opacity: op
        };
      })
    };
  };

  const divider = { type: 'stack', height: 1, backgroundColor: C.barBg, children: [{ type: 'spacer' }] };

  const header = () => ({
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
      { type: 'image', src: 'sf-symbol:server.rack', color: C.text, width: 14, height: 14 },
      { type: 'text', text: d.hostname, font: { size: 'headline', weight: 'bold' }, textColor: C.text, maxLines: 1, minScale: 0.6 },
      { type: 'spacer' },
      { type: 'text', text: `↓${fmtBytes(d.rxRate)}/s ↑${fmtBytes(d.txRate)}/s`, font: { size: 9, family: 'Menlo', weight: 'bold' }, textColor: C.dim, minScale: 0.8 },
      { type: 'text', text: '•', font: { size: 9 }, textColor: C.dim, opacity: 0.6 },
      { type: 'text', text: d.uptime, font: { size: 10, weight: 'medium' }, textColor: C.dim, maxLines: 1, minScale: 0.8 },
    ],
  });

  const footer = {
    type: 'stack', direction: 'row', alignItems: 'center', children: [
      { type: 'image', src: 'sf-symbol:arrow.triangle.2.circlepath', color: C.dim, width: 9, height: 9 },
      { type: 'text', text: ` 刷新于 ${d.timeStr}`, font: { size: 9, weight: 'medium' }, textColor: C.dim },
      { type: 'spacer' },
      { type: 'image', src: 'sf-symbol:calendar', color: C.dim, width: 9, height: 9 },
      { type: 'text', text: ` 流量重置: ${d.tfReset}`, font: { size: 9, family: 'Menlo' }, textColor: C.dim },
    ],
  };

  if (d.error) {
    return {
      type: 'widget', padding: [14, 16], gap: 8, backgroundColor: C.bg,
      children: [
        { type: 'text', text: '⚠️ Connection Failed', font: { size: 'headline', weight: 'bold' }, textColor: getTrafficColor(100) },
        { type: 'text', text: d.error, font: { size: 'caption1' }, textColor: C.dim, maxLines: 3 },
      ],
    };
  }

  // --- 渲染逻辑 ---
  if (ctx.widgetFamily === 'systemSmall') {
    return {
      type: 'widget', backgroundColor: C.bg, padding: [12, 16], gap: 5, 
      children: [
        { type: 'stack', direction: 'column', gap: 1, children: [
          { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
            { type: 'image', src: 'sf-symbol:server.rack', color: C.text, width: 12, height: 12 },
            { type: 'text', text: d.hostname, font: { size: 'subheadline', weight: 'bold' }, textColor: C.text, maxLines: 1 },
          ]},
          { type: 'text', text: d.ipInfo, font: { size: 9, family: 'Menlo', weight: 'bold' }, textColor: C.text },
        ]},
        { type: 'spacer', length: 2 },
        ...[
          { ic: 'cpu', lb: 'CPU', pt: d.cpuPct, v: `${d.cpuPct}%`, c: C.cpu },
          { ic: 'memorychip', lb: 'MEM', pt: d.memPct, v: `${d.memPct}%`, c: C.mem },
          { ic: 'antenna.radiowaves.left.and.right', lb: 'TRAF', pt: d.tfPct, v: `${d.tfPct.toFixed(0)}%`, c: getTrafficColor(d.tfPct) }
        ].map(i => ({
          type: 'stack', direction: 'column', gap: 3, children: [
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
              { type: 'image', src: `sf-symbol:${i.ic}`, color: i.c, width: 10, height: 10 },
              { type: 'text', text: i.lb, font: { size: 10, weight: 'bold' }, textColor: C.text },
              { type: 'spacer' },
              { type: 'text', text: i.v, font: { size: 10, weight: 'heavy', family: 'Menlo' }, textColor: i.c },
            ]},
            bar(i.pt, i.c, 5),
          ]
        }))
      ],
    };
  }

  // Medium 及其他布局参考
  if (ctx.widgetFamily === 'systemMedium') {
    return {
      type: 'widget', backgroundColor: C.bg, padding: [12, 16], 
      children: [
        header(),
        { type: 'spacer' },
        { type: 'stack', direction: 'column', gap: 6, children: [
          { type: 'stack', direction: 'column', gap: 3, children: [
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
              { type: 'image', src: 'sf-symbol:cpu', color: C.cpu, width: 11, height: 11 },
              { type: 'text', text: `CPU ${d.cores}C`, font: { size: 11, weight: 'bold' }, textColor: C.text },
              { type: 'text', text: `${d.cpuPct}%`, font: { size: 11, weight: 'heavy', family: 'Menlo' }, textColor: C.cpu },
              { type: 'spacer' },
              { type: 'text', text: d.ipInfo, font: { size: 10, family: 'Menlo', weight: 'bold' }, textColor: C.text },
            ]},
            bar(d.cpuPct, C.cpu, 6),
          ]},
          { type: 'stack', direction: 'column', gap: 3, children: [
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
              { type: 'image', src: 'sf-symbol:memorychip', color: C.mem, width: 11, height: 11 },
              { type: 'text', text: 'MEM', font: { size: 11, weight: 'bold' }, textColor: C.text },
              { type: 'text', text: `${d.memPct}%`, font: { size: 11, weight: 'heavy', family: 'Menlo' }, textColor: C.mem },
              { type: 'spacer' },
              { type: 'text', text: `${fmtBytes(d.memUsed)} / ${fmtBytes(d.memTotal)}`, font: { size: 10, family: 'Menlo' }, textColor: C.dim },
            ]},
            bar(d.memPct, C.mem, 6),
          ]},
          { type: 'stack', direction: 'column', gap: 3, children: [
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
              { type: 'image', src: 'sf-symbol:antenna.radiowaves.left.and.right', color: getTrafficColor(d.tfPct), width: 11, height: 11 },
              { type: 'text', text: 'TRAF', font: { size: 11, weight: 'bold' }, textColor: C.text },
              { type: 'text', text: `${d.tfPct.toFixed(1)}%`, font: { size: 11, weight: 'heavy', family: 'Menlo' }, textColor: getTrafficColor(d.tfPct) },
              { type: 'spacer' },
              { type: 'text', text: `${fmtBytes(d.tfUsed)} / ${fmtBytes(d.tfTotal)}`, font: { size: 10, family: 'Menlo' }, textColor: C.dim },
            ]},
            bar(d.tfPct, getTrafficColor(d.tfPct), 6),
          ]},
        ]},
        { type: 'spacer' },
        footer,
      ],
    };
  }

  // 默认返回大尺寸布局
  return {
    type: 'widget', backgroundColor: C.bg, padding: [14, 16], gap: 8, 
    children: [
      header(),
      divider,
      { type: 'stack', direction: 'row', alignItems: 'center', gap: 6, children: [
        { type: 'image', src: 'sf-symbol:cpu', color: C.cpu, width: 14, height: 14 },
        { type: 'text', text: `CPU ${d.cores}C`, font: { size: 12, weight: 'bold' }, textColor: C.text },
        { type: 'text', text: `${d.cpuPct}%`, font: { size: 12, weight: 'heavy', family: 'Menlo' }, textColor: C.cpu },
        { type: 'spacer' },
        { type: 'text', text: d.ipInfo, font: { size: 11, family: 'Menlo', weight: 'bold' }, textColor: C.text },
      ]},
      bar(d.cpuPct, C.cpu, 7),
      divider,
      { type: 'stack', direction: 'row', alignItems: 'center', gap: 6, children: [
        { type: 'image', src: 'sf-symbol:memorychip', color: C.mem, width: 14, height: 14 },
        { type: 'text', text: 'MEMORY', font: { size: 12, weight: 'bold' }, textColor: C.text },
        { type: 'text', text: `${d.memPct}%`, font: { size: 12, weight: 'heavy', family: 'Menlo' }, textColor: C.mem },
        { type: 'spacer' },
        { type: 'text', text: `${fmtBytes(d.memUsed)} / ${fmtBytes(d.memTotal)}`, font: { size: 11, family: 'Menlo' }, textColor: C.dim },
      ]},
      bar(d.memPct, C.mem, 7),
      divider,
      { type: 'stack', direction: 'row', alignItems: 'center', gap: 6, children: [
        { type: 'image', src: 'sf-symbol:antenna.radiowaves.left.and.right', color: getTrafficColor(d.tfPct), width: 14, height: 14 },
        { type: 'text', text: 'TRAFFIC', font: { size: 12, weight: 'bold' }, textColor: C.text },
        { type: 'text', text: `${d.tfPct.toFixed(1)}%`, font: { size: 12, weight: 'heavy', family: 'Menlo' }, textColor: getTrafficColor(d.tfPct) },
        { type: 'spacer' },
        { type: 'text', text: `${fmtBytes(d.tfUsed)} / ${fmtBytes(d.tfTotal)}`, font: { size: 11, family: 'Menlo' }, textColor: C.dim },
      ]},
      bar(d.tfPct, getTrafficColor(d.tfPct), 7),
      { type: 'spacer' },
      footer,
    ],
  };
}
