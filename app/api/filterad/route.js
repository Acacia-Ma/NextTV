import {NextResponse} from "next/server";

export const dynamic = "force-dynamic"; // Prevent caching

/**
 * Helper to join URLs
 */
const urljoin = (base, path) => {
  try {
    return new URL(path, base).href;
  } catch (e) {
    return path;
  }
};

/**
 * 智能对比去除广告。支持嵌套m3u8。
 */
const fixAdM3u8AiLatest = async (m3u8_url, headers) => {
  let ts = new Date().getTime();
  let option = headers
    ? {
        headers: headers,
      }
    : {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      };

  function b(s1, s2) {
    let i = 0;
    while (i < s1.length) {
      if (s1[i] !== s2[i]) {
        break;
      }
      i++;
    }
    return i;
  }

  function reverseString(str) {
    return str.split("").reverse().join("");
  }

  console.log("Fetching M3U8:", m3u8_url);

  let response = await fetch(m3u8_url, {
    method: "GET",
    ...option,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch m3u8: ${response.status} ${response.statusText}`,
    );
  }

  let m3u8 = await response.text();

  m3u8 = m3u8
    .trim()
    .split("\n")
    .map((it) => (it.startsWith("#") ? it : urljoin(m3u8_url, it)))
    .join("\n");
  m3u8 = m3u8.replace(/\n\n/gi, "\n");

  let last_url = m3u8.split("\n").slice(-1)[0];
  if (last_url.length < 5) {
    last_url = m3u8.split("\n").slice(-2)[0];
  }

  if (last_url.includes(".m3u8") && last_url !== m3u8_url) {
    m3u8_url = urljoin(m3u8_url, last_url);
    console.log("嵌套的m3u8_url:" + m3u8_url);

    response = await fetch(m3u8_url, {
      method: "GET",
      ...option,
    });

    if (response.ok) {
      m3u8 = await response.text();
    }
  }

  let s = m3u8
    .trim()
    .split("\n")
    .filter((it) => it.trim())
    .join("\n");
  let ss = s.split("\n");
  let firststr = "";
  let maxl = 0;
  let kk = 0;
  let kkk1 = 1;
  let kkk2 = 0;
  let secondstr = "";

  for (let i = 0; i < ss.length; i++) {
    let s = ss[i];
    if (!s.startsWith("#")) {
      if (kk == 0) firststr = s;
      if (kk > 0) {
        if (maxl > b(firststr, s) + 1) {
          if (secondstr.length < 5) secondstr = s;
          kkk2++;
        } else {
          maxl = b(firststr, s);
          kkk1++;
        }
      }
      kk++;
      if (kk >= 30) break;
    }
  }

  if (kkk2 > kkk1) firststr = secondstr;
  let firststrlen = firststr.length;
  let ml = Math.round(ss.length / 2).toString().length;
  let maxc = 0;
  let lastl = firststr.lastIndexOf("/");
  lastl++;
  let laststr = firststr;

  if (maxl !== lastl) {
    laststr = ss.toReversed().find((x) => {
      if (!x.startsWith("#")) {
        let k = b(reverseString(firststr), reverseString(x));
        maxl = b(firststr, x);
        maxc++;
        if (firststrlen - maxl <= ml + k || maxc > 10) {
          return true;
        }
      }
      return false;
    });
    console.log("最后一条切片：" + laststr);
  }

  let ad_urls = [];
  for (let i = 0; i < ss.length; i++) {
    let s = ss[i];
    if (!s.startsWith("#")) {
      if (b(firststr, s) < maxl) {
        ad_urls.push(s);
        ss.splice(i - 1, 2);
        i = i - 2;
      } else {
        ss[i] = urljoin(m3u8_url, s);
      }
    } else {
      ss[i] = s.replace(
        /URI=\"(.*)\"/,
        'URI="' + urljoin(m3u8_url, "$1") + '"',
      );
    }
  }

  console.log("处理的m3u8地址:" + m3u8_url);
  console.log("----广告地址----");
  console.log(ad_urls);

  if (ad_urls.length == 0) {
    console.log("----处理时间广告(基于相同时长统计)----");

    // 按 #EXT-X-DISCONTINUITY 分割成组，检测每组内是否有超过3个相同的 EXTINF 时间值
    let adGroups = []; // 存储需要删除的广告组的位置信息 { startIndex, endIndex }

    let groupStartIndex = -1;
    let groupTimes = []; // 当前组内的所有 EXTINF 时间值

    for (let i = 0; i < ss.length; i++) {
      let s = ss[i];

      if (s.startsWith("#EXTINF")) {
        // 记录组的开始位置
        if (groupStartIndex === -1) {
          groupStartIndex = i;
        }
        // 提取时间值 (格式: #EXTINF:1.800000,)
        let timeMatch = s.match(/#EXTINF:([\d.]+)/);
        if (timeMatch) {
          groupTimes.push(timeMatch[1]);
        }
      }

      // 遇到 DISCONTINUITY 或 ENDLIST 时，检查当前组是否为广告
      if (
        s.startsWith("#EXT-X-DISCONTINUITY") ||
        s.startsWith("#EXT-X-ENDLIST") ||
        i === ss.length - 1
      ) {
        if (groupTimes.length > 0 && groupStartIndex !== -1) {
          // 检查从第一个片段开始，有多少个连续片段与第一个时长相同
          let firstTime = groupTimes[0];
          let consecutiveCount = 1; // 第一个片段自己算1个

          for (let j = 1; j < groupTimes.length; j++) {
            if (groupTimes[j] === firstTime) {
              consecutiveCount++;
            } else {
              // 遇到不同时长的片段，停止计数
              break;
            }
          }

          // 检查最后一个片段时长是否小于1秒
          let lastTime = parseFloat(groupTimes[groupTimes.length - 1]);
          let lastFragmentShort = lastTime <= 1;

          // 广告判定条件：1. 从第一个片段开始连续相同时长的片段数 >= 3  2. 最后一个片段时长 < 1秒
          let isAd = consecutiveCount >= 3 && lastFragmentShort;

          if (isAd) {
            // 计算组的结束位置（包含到当前的 DISCONTINUITY 或最后一个 ts 文件）
            let groupEndIndex = i;
            // 如果当前行是 DISCONTINUITY，组结束于前一行
            if (s.startsWith("#EXT-X-DISCONTINUITY")) {
              groupEndIndex = i; // 包含 DISCONTINUITY 标记
            }

            console.log(
              `发现广告组: 位置 ${groupStartIndex}-${groupEndIndex}, ` +
                `共 ${groupTimes.length} 个片段, ` +
                `从第一个片段开始连续 ${consecutiveCount} 个时长为 ${firstTime}秒`,
            );

            adGroups.push({
              startIndex: groupStartIndex,
              endIndex: groupEndIndex,
            });
          }
        }

        // 重置组状态
        groupStartIndex = -1;
        groupTimes = [];
      }
    }

    // 从后往前删除广告组，避免索引偏移问题
    for (let k = adGroups.length - 1; k >= 0; k--) {
      let {startIndex, endIndex} = adGroups[k];
      let deleteCount = endIndex - startIndex + 1;
      console.log(`删除广告组: 从索引 ${startIndex} 删除 ${deleteCount} 行`);
      ss.splice(startIndex, deleteCount);
    }

    console.log(`共过滤 ${adGroups.length} 个广告组`);
  }

  m3u8 = ss.join("\n");
  console.log("处理耗时：" + (new Date().getTime() - ts).toString());
  return m3u8;
};

// 全局缓存对象 (内存缓存)
const m3u8Cache = new Map();
const CACHE_TTL = 3600 * 1000; // 3600秒 (毫秒单位)

export async function GET(request) {
  const {searchParams} = new URL(request.url);
  const url = searchParams.get("url");

  if (!url) {
    return NextResponse.json({error: "Missing 'url' parameter"}, {status: 400});
  }

  // 1. 检查缓存
  const cachedData = m3u8Cache.get(url);
  if (cachedData) {
    const now = Date.now();
    if (now - cachedData.timestamp < CACHE_TTL) {
      console.log(`[Cache] Hit for ${url}`);
      return new NextResponse(cachedData.content, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } else {
      console.log(`[Cache] Expired for ${url}`);
      m3u8Cache.delete(url);
    }
  }

  try {
    const m3u8Content = await fixAdM3u8AiLatest(url);

    // 2. 存入缓存
    m3u8Cache.set(url, {
      content: m3u8Content,
      timestamp: Date.now(),
    });

    // 简单清理过期缓存 (可选: 每次写入时检查一次)
    if (m3u8Cache.size > 1000) {
      // 防止内存无限增长，简单的清理策略
      const now = Date.now();
      for (const [key, val] of m3u8Cache.entries()) {
        if (now - val.timestamp > CACHE_TTL) {
          m3u8Cache.delete(key);
        }
      }
    }

    return new NextResponse(m3u8Content, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*", // Enable CORS for player
      },
    });
  } catch (error) {
    console.error("Ad filter error:", error);
    return NextResponse.json(
      {error: "Failed to process M3U8", details: error.message},
      {status: 500},
    );
  }
}
