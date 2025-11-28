// 【新增】IP 打码函数 (仅对 IPv4 生效)
function maskIPv4(ip) {
    if (!ip || !ip.includes('.')) return ip;

    // 假设是 IPv4 地址
    const parts = ip.split('.');
    if (parts.length === 4) {
        // 保留 IP 前两段，后两段用 ** 替代
        // 效果示例：74.48.81.105 -> 74.48.**
        return parts[0] + '.' + parts[1] + '.**'; 
    }
    
    // 如果不是标准的 IPv4，则返回原始 IP
    return ip; 
}

let url = "http://ip-api.com/json/?fields=8450015&lang=zh-CN";
$httpClient.get(url, function(error, response, data){
  if (error) {
    console.log("Error fetching IP info: " + error);
    $done({}); // 确保脚本在出错时也能结束
    return;
  }
  
  let jsonData;
  try {
    jsonData = JSON.parse(data);
  } catch (e) {
    console.log("Error parsing JSON data: " + e);
    $done({});
    return;
  }
  
  // 【修改点】应用打码函数到获取到的 IP 地址
  let query = maskIPv4(jsonData.query); 
  
  let isp = jsonData.isp;
  let as = jsonData.as;
  let country = jsonData.country;
  let city = jsonData.city;
  let timezone = jsonData.timezone;
  let lon = jsonData.lon;
  let lat = jsonData.lat;
  let currency = jsonData.currency;
  let emoji = getFlagEmoji(jsonData.countryCode);

  const params = {
    icon: 'mappin.and.ellipse',
    color: '#f50505'
  };

  let body = {
    title: "节点信息",
    // content 使用打码后的 query 变量
    content: `🗺️IP：${query}\n🖥️ISP：${isp}\n#️⃣ASN：${as}\n🌍国家/地区：${emoji}${country}\n🏙城市：${city}\n🕗时区：${timezone}\n📍经纬度：${lon},${lat}\n🪙货币：${currency}`,
    icon: params.icon,
    "icon-color": params.color
  };

  $done(body);
});

function getFlagEmoji(countryCode) {
  if (countryCode.toUpperCase() == 'TW') {
    countryCode = 'CN';
  }
  const codePoints = countryCode
    .toUpperCase()
    .split('')
    .map(char => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}
