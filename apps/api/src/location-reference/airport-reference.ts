/**
 * Controlled flight-search airport references. These identifiers are the only
 * locations accepted by the Shared flight Tool; map/geocoding output is
 * deliberately not a source of flight-search facts.
 *
 * The list is curated on purpose — it is what stops the model inventing an
 * airport — but it is meant to cover the destinations the product actually
 * serves. It began as a five-entry demo fixture (SFO/PVG/NRT/SIN/LIS), which
 * meant flights were unavailable for nearly every trip anyone planned.
 *
 * Cities carry aliases because a confirmed brief stores whatever the traveller
 * wrote: real snapshots hold "Tokyo" and "东京", "Osaka" and "大阪", side by
 * side. Matching only the canonical English spelling made the reference miss
 * airports it already had.
 */
export interface AirportReference {
  id: string;
  iataCode: string;
  city: string;
  countryCode: string;
  /** Other spellings a confirmed brief may hold for this city. */
  cityAliases?: readonly string[];
}

/**
 * Ordered by city, and within a city by which airport carries the most
 * international traffic — `airportIdsForCities` preserves this order, and the
 * flight tool's description lists it, so the model sees the primary gateway
 * first.
 */
const AIRPORTS: readonly AirportReference[] = [
  // ── Japan ──
  { id: "NRT", iataCode: "NRT", city: "Tokyo", countryCode: "JP", cityAliases: ["东京", "東京", "narita"] },
  { id: "HND", iataCode: "HND", city: "Tokyo", countryCode: "JP", cityAliases: ["东京", "東京", "haneda"] },
  { id: "KIX", iataCode: "KIX", city: "Osaka", countryCode: "JP", cityAliases: ["大阪", "kansai", "关西", "關西"] },
  { id: "ITM", iataCode: "ITM", city: "Osaka", countryCode: "JP", cityAliases: ["大阪", "itami"] },
  { id: "NGO", iataCode: "NGO", city: "Nagoya", countryCode: "JP", cityAliases: ["名古屋"] },
  { id: "CTS", iataCode: "CTS", city: "Sapporo", countryCode: "JP", cityAliases: ["札幌", "北海道", "hokkaido"] },
  { id: "FUK", iataCode: "FUK", city: "Fukuoka", countryCode: "JP", cityAliases: ["福冈", "福岡"] },
  { id: "OKA", iataCode: "OKA", city: "Okinawa", countryCode: "JP", cityAliases: ["冲绳", "沖繩", "那霸", "naha"] },
  { id: "HIJ", iataCode: "HIJ", city: "Hiroshima", countryCode: "JP", cityAliases: ["广岛", "廣島"] },
  { id: "SDJ", iataCode: "SDJ", city: "Sendai", countryCode: "JP", cityAliases: ["仙台"] },
  // ── Korea ──
  { id: "ICN", iataCode: "ICN", city: "Seoul", countryCode: "KR", cityAliases: ["首尔", "首爾", "incheon", "仁川"] },
  { id: "GMP", iataCode: "GMP", city: "Seoul", countryCode: "KR", cityAliases: ["首尔", "首爾", "gimpo"] },
  { id: "PUS", iataCode: "PUS", city: "Busan", countryCode: "KR", cityAliases: ["釜山"] },
  { id: "CJU", iataCode: "CJU", city: "Jeju", countryCode: "KR", cityAliases: ["济州", "濟州"] },
  // ── Chinese mainland ──
  { id: "PEK", iataCode: "PEK", city: "Beijing", countryCode: "CN", cityAliases: ["北京"] },
  { id: "PKX", iataCode: "PKX", city: "Beijing", countryCode: "CN", cityAliases: ["北京", "大兴", "daxing"] },
  { id: "PVG", iataCode: "PVG", city: "Shanghai", countryCode: "CN", cityAliases: ["上海", "浦东", "pudong"] },
  { id: "SHA", iataCode: "SHA", city: "Shanghai", countryCode: "CN", cityAliases: ["上海", "虹桥", "hongqiao"] },
  { id: "CAN", iataCode: "CAN", city: "Guangzhou", countryCode: "CN", cityAliases: ["广州", "廣州"] },
  { id: "SZX", iataCode: "SZX", city: "Shenzhen", countryCode: "CN", cityAliases: ["深圳"] },
  { id: "TFU", iataCode: "TFU", city: "Chengdu", countryCode: "CN", cityAliases: ["成都", "天府"] },
  { id: "CTU", iataCode: "CTU", city: "Chengdu", countryCode: "CN", cityAliases: ["成都", "双流"] },
  { id: "CKG", iataCode: "CKG", city: "Chongqing", countryCode: "CN", cityAliases: ["重庆", "重慶"] },
  { id: "XIY", iataCode: "XIY", city: "Xi'an", countryCode: "CN", cityAliases: ["西安", "xian"] },
  { id: "HGH", iataCode: "HGH", city: "Hangzhou", countryCode: "CN", cityAliases: ["杭州"] },
  { id: "NKG", iataCode: "NKG", city: "Nanjing", countryCode: "CN", cityAliases: ["南京"] },
  { id: "TAO", iataCode: "TAO", city: "Qingdao", countryCode: "CN", cityAliases: ["青岛", "青島"] },
  { id: "XMN", iataCode: "XMN", city: "Xiamen", countryCode: "CN", cityAliases: ["厦门", "廈門"] },
  { id: "KMG", iataCode: "KMG", city: "Kunming", countryCode: "CN", cityAliases: ["昆明"] },
  { id: "SYX", iataCode: "SYX", city: "Sanya", countryCode: "CN", cityAliases: ["三亚", "三亞"] },
  { id: "HAK", iataCode: "HAK", city: "Haikou", countryCode: "CN", cityAliases: ["海口"] },
  { id: "WUH", iataCode: "WUH", city: "Wuhan", countryCode: "CN", cityAliases: ["武汉", "武漢"] },
  { id: "CSX", iataCode: "CSX", city: "Changsha", countryCode: "CN", cityAliases: ["长沙", "長沙"] },
  { id: "CGO", iataCode: "CGO", city: "Zhengzhou", countryCode: "CN", cityAliases: ["郑州", "鄭州"] },
  { id: "TSN", iataCode: "TSN", city: "Tianjin", countryCode: "CN", cityAliases: ["天津"] },
  { id: "DLC", iataCode: "DLC", city: "Dalian", countryCode: "CN", cityAliases: ["大连", "大連"] },
  { id: "SHE", iataCode: "SHE", city: "Shenyang", countryCode: "CN", cityAliases: ["沈阳", "瀋陽"] },
  { id: "HRB", iataCode: "HRB", city: "Harbin", countryCode: "CN", cityAliases: ["哈尔滨", "哈爾濱"] },
  { id: "URC", iataCode: "URC", city: "Urumqi", countryCode: "CN", cityAliases: ["乌鲁木齐", "烏魯木齊"] },
  { id: "LXA", iataCode: "LXA", city: "Lhasa", countryCode: "CN", cityAliases: ["拉萨", "拉薩"] },
  { id: "KWE", iataCode: "KWE", city: "Guiyang", countryCode: "CN", cityAliases: ["贵阳", "貴陽"] },
  { id: "NNG", iataCode: "NNG", city: "Nanning", countryCode: "CN", cityAliases: ["南宁", "南寧"] },
  { id: "FOC", iataCode: "FOC", city: "Fuzhou", countryCode: "CN", cityAliases: ["福州"] },
  { id: "HFE", iataCode: "HFE", city: "Hefei", countryCode: "CN", cityAliases: ["合肥"] },
  { id: "TNA", iataCode: "TNA", city: "Jinan", countryCode: "CN", cityAliases: ["济南", "濟南"] },
  { id: "TYN", iataCode: "TYN", city: "Taiyuan", countryCode: "CN", cityAliases: ["太原"] },
  { id: "LJG", iataCode: "LJG", city: "Lijiang", countryCode: "CN", cityAliases: ["丽江", "麗江"] },
  { id: "JJN", iataCode: "JJN", city: "Quanzhou", countryCode: "CN", cityAliases: ["泉州", "晋江"] },
  { id: "HKG", iataCode: "HKG", city: "Hong Kong", countryCode: "HK", cityAliases: ["香港"] },
  { id: "MFM", iataCode: "MFM", city: "Macau", countryCode: "MO", cityAliases: ["澳门", "澳門", "macao"] },
  { id: "TPE", iataCode: "TPE", city: "Taipei", countryCode: "TW", cityAliases: ["台北", "臺北", "桃园", "taoyuan"] },
  { id: "TSA", iataCode: "TSA", city: "Taipei", countryCode: "TW", cityAliases: ["台北", "臺北", "松山"] },
  { id: "KHH", iataCode: "KHH", city: "Kaohsiung", countryCode: "TW", cityAliases: ["高雄"] },
  // ── Southeast Asia ──
  { id: "SIN", iataCode: "SIN", city: "Singapore", countryCode: "SG", cityAliases: ["新加坡"] },
  { id: "KUL", iataCode: "KUL", city: "Kuala Lumpur", countryCode: "MY", cityAliases: ["吉隆坡"] },
  { id: "PEN", iataCode: "PEN", city: "Penang", countryCode: "MY", cityAliases: ["槟城", "檳城"] },
  { id: "BKK", iataCode: "BKK", city: "Bangkok", countryCode: "TH", cityAliases: ["曼谷", "suvarnabhumi"] },
  { id: "DMK", iataCode: "DMK", city: "Bangkok", countryCode: "TH", cityAliases: ["曼谷", "don mueang"] },
  { id: "HKT", iataCode: "HKT", city: "Phuket", countryCode: "TH", cityAliases: ["普吉", "普吉岛"] },
  { id: "CNX", iataCode: "CNX", city: "Chiang Mai", countryCode: "TH", cityAliases: ["清迈", "清邁"] },
  { id: "HAN", iataCode: "HAN", city: "Hanoi", countryCode: "VN", cityAliases: ["河内", "河內"] },
  { id: "SGN", iataCode: "SGN", city: "Ho Chi Minh City", countryCode: "VN", cityAliases: ["胡志明", "胡志明市", "西贡", "saigon"] },
  { id: "DAD", iataCode: "DAD", city: "Da Nang", countryCode: "VN", cityAliases: ["岘港", "峴港", "danang"] },
  { id: "CGK", iataCode: "CGK", city: "Jakarta", countryCode: "ID", cityAliases: ["雅加达", "雅加達"] },
  { id: "DPS", iataCode: "DPS", city: "Bali", countryCode: "ID", cityAliases: ["巴厘岛", "峇里島", "denpasar"] },
  { id: "MNL", iataCode: "MNL", city: "Manila", countryCode: "PH", cityAliases: ["马尼拉", "馬尼拉"] },
  { id: "CEB", iataCode: "CEB", city: "Cebu", countryCode: "PH", cityAliases: ["宿务", "宿霧"] },
  { id: "PNH", iataCode: "PNH", city: "Phnom Penh", countryCode: "KH", cityAliases: ["金边", "金邊"] },
  { id: "RGN", iataCode: "RGN", city: "Yangon", countryCode: "MM", cityAliases: ["仰光"] },
  { id: "VTE", iataCode: "VTE", city: "Vientiane", countryCode: "LA", cityAliases: ["万象", "萬象"] },
  { id: "BWN", iataCode: "BWN", city: "Bandar Seri Begawan", countryCode: "BN", cityAliases: ["文莱", "brunei"] },
  // ── South Asia ──
  { id: "DEL", iataCode: "DEL", city: "Delhi", countryCode: "IN", cityAliases: ["德里", "新德里", "new delhi"] },
  { id: "BOM", iataCode: "BOM", city: "Mumbai", countryCode: "IN", cityAliases: ["孟买", "孟買"] },
  { id: "BLR", iataCode: "BLR", city: "Bengaluru", countryCode: "IN", cityAliases: ["班加罗尔", "bangalore"] },
  { id: "MAA", iataCode: "MAA", city: "Chennai", countryCode: "IN", cityAliases: ["金奈"] },
  { id: "CCU", iataCode: "CCU", city: "Kolkata", countryCode: "IN", cityAliases: ["加尔各答"] },
  { id: "HYD", iataCode: "HYD", city: "Hyderabad", countryCode: "IN", cityAliases: ["海得拉巴"] },
  { id: "CMB", iataCode: "CMB", city: "Colombo", countryCode: "LK", cityAliases: ["科伦坡", "斯里兰卡"] },
  { id: "KTM", iataCode: "KTM", city: "Kathmandu", countryCode: "NP", cityAliases: ["加德满都"] },
  { id: "DAC", iataCode: "DAC", city: "Dhaka", countryCode: "BD", cityAliases: ["达卡"] },
  { id: "MLE", iataCode: "MLE", city: "Male", countryCode: "MV", cityAliases: ["马尔代夫", "馬爾地夫", "maldives", "malé"] },
  // ── Middle East ──
  { id: "DXB", iataCode: "DXB", city: "Dubai", countryCode: "AE", cityAliases: ["迪拜", "杜拜"] },
  { id: "AUH", iataCode: "AUH", city: "Abu Dhabi", countryCode: "AE", cityAliases: ["阿布扎比"] },
  { id: "DOH", iataCode: "DOH", city: "Doha", countryCode: "QA", cityAliases: ["多哈"] },
  { id: "IST", iataCode: "IST", city: "Istanbul", countryCode: "TR", cityAliases: ["伊斯坦布尔", "伊斯坦堡"] },
  { id: "SAW", iataCode: "SAW", city: "Istanbul", countryCode: "TR", cityAliases: ["伊斯坦布尔", "sabiha"] },
  { id: "TLV", iataCode: "TLV", city: "Tel Aviv", countryCode: "IL", cityAliases: ["特拉维夫"] },
  { id: "RUH", iataCode: "RUH", city: "Riyadh", countryCode: "SA", cityAliases: ["利雅得"] },
  { id: "JED", iataCode: "JED", city: "Jeddah", countryCode: "SA", cityAliases: ["吉达"] },
  // ── Oceania ──
  { id: "SYD", iataCode: "SYD", city: "Sydney", countryCode: "AU", cityAliases: ["悉尼", "雪梨"] },
  { id: "MEL", iataCode: "MEL", city: "Melbourne", countryCode: "AU", cityAliases: ["墨尔本", "墨爾本"] },
  { id: "BNE", iataCode: "BNE", city: "Brisbane", countryCode: "AU", cityAliases: ["布里斯班"] },
  { id: "PER", iataCode: "PER", city: "Perth", countryCode: "AU", cityAliases: ["珀斯"] },
  { id: "ADL", iataCode: "ADL", city: "Adelaide", countryCode: "AU", cityAliases: ["阿德莱德"] },
  { id: "CNS", iataCode: "CNS", city: "Cairns", countryCode: "AU", cityAliases: ["凯恩斯"] },
  { id: "AKL", iataCode: "AKL", city: "Auckland", countryCode: "NZ", cityAliases: ["奥克兰", "奧克蘭"] },
  { id: "CHC", iataCode: "CHC", city: "Christchurch", countryCode: "NZ", cityAliases: ["基督城"] },
  { id: "ZQN", iataCode: "ZQN", city: "Queenstown", countryCode: "NZ", cityAliases: ["皇后镇"] },
  { id: "NAN", iataCode: "NAN", city: "Nadi", countryCode: "FJ", cityAliases: ["斐济", "fiji"] },
  // ── Europe ──
  { id: "LHR", iataCode: "LHR", city: "London", countryCode: "GB", cityAliases: ["伦敦", "倫敦", "heathrow"] },
  { id: "LGW", iataCode: "LGW", city: "London", countryCode: "GB", cityAliases: ["伦敦", "倫敦", "gatwick"] },
  { id: "STN", iataCode: "STN", city: "London", countryCode: "GB", cityAliases: ["伦敦", "倫敦", "stansted"] },
  { id: "MAN", iataCode: "MAN", city: "Manchester", countryCode: "GB", cityAliases: ["曼彻斯特"] },
  { id: "EDI", iataCode: "EDI", city: "Edinburgh", countryCode: "GB", cityAliases: ["爱丁堡", "愛丁堡"] },
  { id: "DUB", iataCode: "DUB", city: "Dublin", countryCode: "IE", cityAliases: ["都柏林"] },
  { id: "CDG", iataCode: "CDG", city: "Paris", countryCode: "FR", cityAliases: ["巴黎", "戴高乐"] },
  { id: "ORY", iataCode: "ORY", city: "Paris", countryCode: "FR", cityAliases: ["巴黎", "orly"] },
  { id: "NCE", iataCode: "NCE", city: "Nice", countryCode: "FR", cityAliases: ["尼斯"] },
  { id: "LYS", iataCode: "LYS", city: "Lyon", countryCode: "FR", cityAliases: ["里昂"] },
  { id: "MRS", iataCode: "MRS", city: "Marseille", countryCode: "FR", cityAliases: ["马赛"] },
  { id: "AMS", iataCode: "AMS", city: "Amsterdam", countryCode: "NL", cityAliases: ["阿姆斯特丹"] },
  { id: "BRU", iataCode: "BRU", city: "Brussels", countryCode: "BE", cityAliases: ["布鲁塞尔"] },
  { id: "FRA", iataCode: "FRA", city: "Frankfurt", countryCode: "DE", cityAliases: ["法兰克福", "法蘭克福"] },
  { id: "MUC", iataCode: "MUC", city: "Munich", countryCode: "DE", cityAliases: ["慕尼黑"] },
  { id: "BER", iataCode: "BER", city: "Berlin", countryCode: "DE", cityAliases: ["柏林"] },
  { id: "HAM", iataCode: "HAM", city: "Hamburg", countryCode: "DE", cityAliases: ["汉堡", "漢堡"] },
  { id: "DUS", iataCode: "DUS", city: "Dusseldorf", countryCode: "DE", cityAliases: ["杜塞尔多夫", "düsseldorf"] },
  { id: "ZRH", iataCode: "ZRH", city: "Zurich", countryCode: "CH", cityAliases: ["苏黎世", "蘇黎世", "zürich"] },
  { id: "GVA", iataCode: "GVA", city: "Geneva", countryCode: "CH", cityAliases: ["日内瓦"] },
  { id: "VIE", iataCode: "VIE", city: "Vienna", countryCode: "AT", cityAliases: ["维也纳", "維也納"] },
  { id: "FCO", iataCode: "FCO", city: "Rome", countryCode: "IT", cityAliases: ["罗马", "羅馬"] },
  { id: "MXP", iataCode: "MXP", city: "Milan", countryCode: "IT", cityAliases: ["米兰", "米蘭", "malpensa"] },
  { id: "LIN", iataCode: "LIN", city: "Milan", countryCode: "IT", cityAliases: ["米兰", "linate"] },
  { id: "VCE", iataCode: "VCE", city: "Venice", countryCode: "IT", cityAliases: ["威尼斯"] },
  { id: "FLR", iataCode: "FLR", city: "Florence", countryCode: "IT", cityAliases: ["佛罗伦萨", "佛羅倫斯"] },
  { id: "NAP", iataCode: "NAP", city: "Naples", countryCode: "IT", cityAliases: ["那不勒斯"] },
  { id: "BLQ", iataCode: "BLQ", city: "Bologna", countryCode: "IT", cityAliases: ["博洛尼亚"] },
  { id: "CTA", iataCode: "CTA", city: "Catania", countryCode: "IT", cityAliases: ["卡塔尼亚", "西西里"] },
  { id: "MAD", iataCode: "MAD", city: "Madrid", countryCode: "ES", cityAliases: ["马德里", "馬德里"] },
  { id: "BCN", iataCode: "BCN", city: "Barcelona", countryCode: "ES", cityAliases: ["巴塞罗那", "巴塞隆納"] },
  { id: "AGP", iataCode: "AGP", city: "Malaga", countryCode: "ES", cityAliases: ["马拉加", "málaga"] },
  { id: "SVQ", iataCode: "SVQ", city: "Seville", countryCode: "ES", cityAliases: ["塞维利亚", "sevilla"] },
  { id: "VLC", iataCode: "VLC", city: "Valencia", countryCode: "ES", cityAliases: ["瓦伦西亚"] },
  { id: "PMI", iataCode: "PMI", city: "Palma", countryCode: "ES", cityAliases: ["马略卡", "mallorca"] },
  { id: "LIS", iataCode: "LIS", city: "Lisbon", countryCode: "PT", cityAliases: ["里斯本", "lisboa"] },
  { id: "OPO", iataCode: "OPO", city: "Porto", countryCode: "PT", cityAliases: ["波尔图", "波爾圖"] },
  { id: "ATH", iataCode: "ATH", city: "Athens", countryCode: "GR", cityAliases: ["雅典"] },
  { id: "CPH", iataCode: "CPH", city: "Copenhagen", countryCode: "DK", cityAliases: ["哥本哈根"] },
  { id: "ARN", iataCode: "ARN", city: "Stockholm", countryCode: "SE", cityAliases: ["斯德哥尔摩"] },
  { id: "OSL", iataCode: "OSL", city: "Oslo", countryCode: "NO", cityAliases: ["奥斯陆", "奧斯陸"] },
  { id: "HEL", iataCode: "HEL", city: "Helsinki", countryCode: "FI", cityAliases: ["赫尔辛基"] },
  { id: "KEF", iataCode: "KEF", city: "Reykjavik", countryCode: "IS", cityAliases: ["雷克雅未克", "冰岛", "reykjavík"] },
  { id: "PRG", iataCode: "PRG", city: "Prague", countryCode: "CZ", cityAliases: ["布拉格", "praha"] },
  { id: "BUD", iataCode: "BUD", city: "Budapest", countryCode: "HU", cityAliases: ["布达佩斯", "布達佩斯"] },
  { id: "WAW", iataCode: "WAW", city: "Warsaw", countryCode: "PL", cityAliases: ["华沙", "華沙"] },
  { id: "KRK", iataCode: "KRK", city: "Krakow", countryCode: "PL", cityAliases: ["克拉科夫", "kraków"] },
  { id: "OTP", iataCode: "OTP", city: "Bucharest", countryCode: "RO", cityAliases: ["布加勒斯特"] },
  { id: "SOF", iataCode: "SOF", city: "Sofia", countryCode: "BG", cityAliases: ["索菲亚"] },
  { id: "BEG", iataCode: "BEG", city: "Belgrade", countryCode: "RS", cityAliases: ["贝尔格莱德"] },
  { id: "ZAG", iataCode: "ZAG", city: "Zagreb", countryCode: "HR", cityAliases: ["萨格勒布"] },
  { id: "SPU", iataCode: "SPU", city: "Split", countryCode: "HR", cityAliases: ["斯普利特"] },
  { id: "DBV", iataCode: "DBV", city: "Dubrovnik", countryCode: "HR", cityAliases: ["杜布罗夫尼克"] },
  { id: "LJU", iataCode: "LJU", city: "Ljubljana", countryCode: "SI", cityAliases: ["卢布尔雅那"] },
  { id: "TLL", iataCode: "TLL", city: "Tallinn", countryCode: "EE", cityAliases: ["塔林"] },
  { id: "RIX", iataCode: "RIX", city: "Riga", countryCode: "LV", cityAliases: ["里加"] },
  { id: "VNO", iataCode: "VNO", city: "Vilnius", countryCode: "LT", cityAliases: ["维尔纽斯"] },
  { id: "SVO", iataCode: "SVO", city: "Moscow", countryCode: "RU", cityAliases: ["莫斯科", "sheremetyevo"] },
  { id: "DME", iataCode: "DME", city: "Moscow", countryCode: "RU", cityAliases: ["莫斯科", "domodedovo"] },
  { id: "LED", iataCode: "LED", city: "Saint Petersburg", countryCode: "RU", cityAliases: ["圣彼得堡", "st petersburg"] },
  // ── North America ──
  { id: "JFK", iataCode: "JFK", city: "New York", countryCode: "US", cityAliases: ["纽约", "紐約", "nyc"] },
  { id: "EWR", iataCode: "EWR", city: "New York", countryCode: "US", cityAliases: ["纽约", "紐約", "newark"] },
  { id: "LGA", iataCode: "LGA", city: "New York", countryCode: "US", cityAliases: ["纽约", "紐約", "laguardia"] },
  { id: "LAX", iataCode: "LAX", city: "Los Angeles", countryCode: "US", cityAliases: ["洛杉矶", "洛杉磯", "la"] },
  { id: "SFO", iataCode: "SFO", city: "San Francisco", countryCode: "US", cityAliases: ["旧金山", "舊金山", "三藩市"] },
  { id: "ORD", iataCode: "ORD", city: "Chicago", countryCode: "US", cityAliases: ["芝加哥", "o'hare"] },
  { id: "SEA", iataCode: "SEA", city: "Seattle", countryCode: "US", cityAliases: ["西雅图", "西雅圖"] },
  { id: "BOS", iataCode: "BOS", city: "Boston", countryCode: "US", cityAliases: ["波士顿", "波士頓"] },
  { id: "IAD", iataCode: "IAD", city: "Washington", countryCode: "US", cityAliases: ["华盛顿", "華盛頓", "dulles"] },
  { id: "DCA", iataCode: "DCA", city: "Washington", countryCode: "US", cityAliases: ["华盛顿", "華盛頓", "reagan"] },
  { id: "MIA", iataCode: "MIA", city: "Miami", countryCode: "US", cityAliases: ["迈阿密", "邁阿密"] },
  { id: "MCO", iataCode: "MCO", city: "Orlando", countryCode: "US", cityAliases: ["奥兰多", "奧蘭多"] },
  { id: "ATL", iataCode: "ATL", city: "Atlanta", countryCode: "US", cityAliases: ["亚特兰大", "亞特蘭大"] },
  { id: "DFW", iataCode: "DFW", city: "Dallas", countryCode: "US", cityAliases: ["达拉斯", "達拉斯"] },
  { id: "IAH", iataCode: "IAH", city: "Houston", countryCode: "US", cityAliases: ["休斯顿", "休士頓"] },
  { id: "DEN", iataCode: "DEN", city: "Denver", countryCode: "US", cityAliases: ["丹佛"] },
  { id: "LAS", iataCode: "LAS", city: "Las Vegas", countryCode: "US", cityAliases: ["拉斯维加斯", "拉斯維加斯"] },
  { id: "PHX", iataCode: "PHX", city: "Phoenix", countryCode: "US", cityAliases: ["凤凰城", "鳳凰城"] },
  { id: "SAN", iataCode: "SAN", city: "San Diego", countryCode: "US", cityAliases: ["圣地亚哥", "聖地牙哥"] },
  { id: "PDX", iataCode: "PDX", city: "Portland", countryCode: "US", cityAliases: ["波特兰"] },
  { id: "AUS", iataCode: "AUS", city: "Austin", countryCode: "US", cityAliases: ["奥斯汀"] },
  { id: "PHL", iataCode: "PHL", city: "Philadelphia", countryCode: "US", cityAliases: ["费城", "費城"] },
  { id: "DTW", iataCode: "DTW", city: "Detroit", countryCode: "US", cityAliases: ["底特律"] },
  { id: "MSP", iataCode: "MSP", city: "Minneapolis", countryCode: "US", cityAliases: ["明尼阿波利斯"] },
  { id: "SLC", iataCode: "SLC", city: "Salt Lake City", countryCode: "US", cityAliases: ["盐湖城"] },
  { id: "HNL", iataCode: "HNL", city: "Honolulu", countryCode: "US", cityAliases: ["檀香山", "夏威夷", "hawaii"] },
  { id: "ANC", iataCode: "ANC", city: "Anchorage", countryCode: "US", cityAliases: ["安克雷奇", "阿拉斯加"] },
  { id: "YYZ", iataCode: "YYZ", city: "Toronto", countryCode: "CA", cityAliases: ["多伦多", "多倫多"] },
  { id: "YVR", iataCode: "YVR", city: "Vancouver", countryCode: "CA", cityAliases: ["温哥华", "溫哥華"] },
  { id: "YUL", iataCode: "YUL", city: "Montreal", countryCode: "CA", cityAliases: ["蒙特利尔", "montréal"] },
  { id: "YYC", iataCode: "YYC", city: "Calgary", countryCode: "CA", cityAliases: ["卡尔加里"] },
  { id: "YOW", iataCode: "YOW", city: "Ottawa", countryCode: "CA", cityAliases: ["渥太华"] },
  { id: "MEX", iataCode: "MEX", city: "Mexico City", countryCode: "MX", cityAliases: ["墨西哥城"] },
  { id: "CUN", iataCode: "CUN", city: "Cancun", countryCode: "MX", cityAliases: ["坎昆", "cancún"] },
  // ── South America ──
  { id: "GRU", iataCode: "GRU", city: "Sao Paulo", countryCode: "BR", cityAliases: ["圣保罗", "são paulo"] },
  { id: "GIG", iataCode: "GIG", city: "Rio de Janeiro", countryCode: "BR", cityAliases: ["里约热内卢", "里約熱內盧", "rio"] },
  { id: "EZE", iataCode: "EZE", city: "Buenos Aires", countryCode: "AR", cityAliases: ["布宜诺斯艾利斯"] },
  { id: "SCL", iataCode: "SCL", city: "Santiago", countryCode: "CL", cityAliases: ["圣地亚哥智利"] },
  { id: "LIM", iataCode: "LIM", city: "Lima", countryCode: "PE", cityAliases: ["利马"] },
  { id: "CUZ", iataCode: "CUZ", city: "Cusco", countryCode: "PE", cityAliases: ["库斯科", "cuzco"] },
  { id: "BOG", iataCode: "BOG", city: "Bogota", countryCode: "CO", cityAliases: ["波哥大", "bogotá"] },
  { id: "UIO", iataCode: "UIO", city: "Quito", countryCode: "EC", cityAliases: ["基多"] },
  // ── Africa ──
  { id: "CAI", iataCode: "CAI", city: "Cairo", countryCode: "EG", cityAliases: ["开罗", "開羅"] },
  { id: "JNB", iataCode: "JNB", city: "Johannesburg", countryCode: "ZA", cityAliases: ["约翰内斯堡"] },
  { id: "CPT", iataCode: "CPT", city: "Cape Town", countryCode: "ZA", cityAliases: ["开普敦", "開普敦"] },
  { id: "NBO", iataCode: "NBO", city: "Nairobi", countryCode: "KE", cityAliases: ["内罗毕"] },
  { id: "CMN", iataCode: "CMN", city: "Casablanca", countryCode: "MA", cityAliases: ["卡萨布兰卡"] },
  { id: "RAK", iataCode: "RAK", city: "Marrakesh", countryCode: "MA", cityAliases: ["马拉喀什", "marrakech"] },
  { id: "ADD", iataCode: "ADD", city: "Addis Ababa", countryCode: "ET", cityAliases: ["亚的斯亚贝巴"] },
  { id: "LOS", iataCode: "LOS", city: "Lagos", countryCode: "NG", cityAliases: ["拉各斯"] },
  { id: "ZNZ", iataCode: "ZNZ", city: "Zanzibar", countryCode: "TZ", cityAliases: ["桑给巴尔"] },
];

const byId = new Map(AIRPORTS.map((airport) => [airport.id, airport]));

/**
 * One spelling reduced to a comparison key: case-folded, diacritics dropped,
 * and separators removed, so "São Paulo" / "sao paulo" / "Sao-Paulo" and
 * "Xi'an" / "xian" all meet. CJK text passes through unchanged.
 */
function cityKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s'’.\-_]/g, "");
}

const byCityKey = new Map<string, AirportReference[]>();
for (const airport of AIRPORTS) {
  for (const spelling of [airport.city, ...(airport.cityAliases ?? [])]) {
    const key = cityKey(spelling);
    const bucket = byCityKey.get(key);
    if (bucket) bucket.push(airport);
    else byCityKey.set(key, [airport]);
  }
}

export function resolveAirportReference(id: string): AirportReference | null {
  return byId.get(id) ?? null;
}

export function isControlledIata(value: string): boolean {
  return /^[A-Z]{3}$/.test(value) && byId.has(value);
}

/**
 * Controlled airport ids serving these cities, in the order the cities were
 * given and, within a city, primary gateway first. A city with no controlled
 * airport contributes nothing — callers treat its absence as a flight gap
 * rather than guessing a nearby code.
 *
 * Matching goes through `cityKey`, so a brief that stored "东京" resolves the
 * same airports as one that stored "Tokyo". Exact English matching alone used
 * to miss airports the reference already held, because a confirmed brief keeps
 * whatever spelling the traveller used.
 */
export function airportIdsForCities(cities: readonly string[]): string[] {
  const ids: string[] = [];
  for (const city of cities) {
    for (const airport of byCityKey.get(cityKey(city)) ?? []) {
      if (!ids.includes(airport.id)) ids.push(airport.id);
    }
  }
  return ids;
}

/**
 * Whether this airport serves the city as the traveller wrote it. Uses the
 * same key as `airportIdsForCities`, so a snapshot candidate stored "东京"
 * matches NRT exactly as "Tokyo" does — comparing the canonical English name
 * alone rejected a search whose destination was in the snapshot all along.
 */
export function airportServesCity(airport: AirportReference, city: string): boolean {
  const key = cityKey(city);
  return (byCityKey.get(key) ?? []).some((candidate) => candidate.id === airport.id);
}

/** Every controlled airport, for diagnostics and reference listings. */
export function controlledAirports(): readonly AirportReference[] {
  return AIRPORTS;
}

/**
 * The controlled flight routes a snapshot's cities actually permit, plus the
 * city each airport stands for.
 *
 * A route is written two ways in this system: suppliers take airport ids, the
 * snapshot holds the traveller's own words. Three readers derived that
 * translation independently — the model gateway's required-cell matrix, the
 * coverage fan-out, and the database completeness check — and they disagreed.
 * The gateway asked for `Singapore → Shanghai` while every search the model
 * was allowed to run was `SIN → SHA` / `SIN → PVG`, so its matrix could never
 * complete: it forced another `flight.search` on every turn until the budget
 * ran out. Deriving it once removes the class, not just the instance.
 *
 * A city with no controlled airport contributes no route. That is deliberate
 * (§#22): the caller reports it as a flight gap rather than guessing at a
 * neighbouring code.
 */
export interface FlightRouteMatrix {
  /** Controlled origin airport ids, in snapshot order. */
  readonly originIds: string[];
  /** Controlled destination airport ids, in snapshot order. */
  readonly destinationIds: string[];
  /** Every origin × destination pair the matrix requires. */
  readonly cells: ReadonlyArray<{ originId: string; destinationId: string }>;
  /** Snapshot cities that resolved to no controlled airport. */
  readonly citiesWithoutAirport: string[];
  /**
   * The snapshot city an airport id stands for. Gaps and copy name the city
   * the traveller wrote; "(PVG)" is not an answer to "where could I not go".
   */
  cityFor(airportId: string): string | null;
}

export function resolveFlightRouteMatrix(params: {
  departureCities: readonly string[];
  destinationCandidates: readonly string[];
}): FlightRouteMatrix {
  const cityByAirport = new Map<string, string>();
  const resolve = (cities: readonly string[], missing: string[]): string[] => {
    const ids: string[] = [];
    for (const city of cities) {
      // A snapshot entry may already be a controlled airport id — an operator
      // fixture, or a brief a traveller wrote as "NRT". Accept it as itself
      // rather than reporting the trip as having no airport, which is what
      // resolving by city name alone would say.
      const asAirport = resolveAirportReference(city);
      if (asAirport) {
        if (!ids.includes(asAirport.id)) ids.push(asAirport.id);
        if (!cityByAirport.has(asAirport.id)) cityByAirport.set(asAirport.id, asAirport.city);
        continue;
      }
      const forCity = airportIdsForCities([city]);
      if (forCity.length === 0) {
        if (!missing.includes(city)) missing.push(city);
        continue;
      }
      for (const id of forCity) {
        if (!ids.includes(id)) ids.push(id);
        if (!cityByAirport.has(id)) cityByAirport.set(id, city);
      }
    }
    return ids;
  };

  const citiesWithoutAirport: string[] = [];
  const originIds = resolve(params.departureCities, citiesWithoutAirport);
  const destinationIds = resolve(params.destinationCandidates, citiesWithoutAirport);
  const cells = originIds.flatMap((originId) =>
    destinationIds.map((destinationId) => ({ originId, destinationId })),
  );

  return {
    originIds,
    destinationIds,
    cells,
    citiesWithoutAirport,
    cityFor: (airportId: string) => cityByAirport.get(airportId) ?? null,
  };
}
