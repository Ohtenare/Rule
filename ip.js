let url = "http://ip-api.com/json/?fields=8450015&lang=zh-CN";

const args = $argument
  ? Object.fromEntries(
      $argument.split("&").map(i => {
        let [k, v] = i.split("=");
        return [k, v];
      })
    )
  : {};

function maskIPv4(ip) {
  let parts = ip.split(".");
  if (parts.length !== 4) return ip;
  return `${parts[0]}.${parts[1]}.*.*`;
}

function maskIPv6(ip) {
  let parts = ip.split(":");
  if (parts.length < 3) return ip;
  return parts.slice(0, 6).join(":") + ":****";
}

function maskIP(ip) {
  if (!args.mask || args.mask != "1") return ip;
  return ip.includes(".") ? maskIPv4(ip) : maskIPv6(ip);
}

$httpClient.get(url, function (error, response, data) {
  let jsonData = JSON.parse(data);
  let query = maskIP(jsonData.query);
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
    icon: args.icon || "mappin.and.ellipse",
    color: args.color || "#f50505"
  };

  let body = {
    title: "节点信息",
    content: `🗺️IP：${query}\n🖥️ISP：${isp}\n#️⃣ASN：${as}\n🌍国家/地区：${emoji}${country}\n🏙城市：${city}\n🕗时区：${timezone}\n📍经纬度：${lon},${lat}\n🪙货币：${currency}`,
    icon: params.icon,
    "icon-color": params.color
  };

  $done(body);
});

function getFlagEmoji(countryCode) {
  if (countryCode.toUpperCase() == "TW") {
    countryCode = "CN";
  }
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map(char => 127397 + char.charCodeAt());
  return String.fromCodePoint(...codePoints);
}
