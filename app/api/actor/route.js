import {NextResponse} from "next/server";
import {getRandomUserAgentWithInfo, getSecChUaHeaders} from "@/lib/user-agent";

/**
 * 创建带有 code 和 status 属性的错误
 */
function createError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function parseDoubanDetails(html, id) {
  try {
    // 提取基本信息
    const titleMatch = html.match(
      /<h1[^>]*>[\s\S]*?<span[^>]*property="v:itemreviewed"[^>]*>([^<]+)<\/span>/
    );
    const title = titleMatch ? titleMatch[1].trim() : "";

    // 主演
    let cast = [];
    const castMatch = html.match(
      /<span class=['"]pl['"]>主演<\/span>:\s*<span class=['"]attrs['"]>(.*?)<\/span>/
    );
    if (castMatch) {
      const castLinks = castMatch[1].match(/<a[^>]*>([^<]+)<\/a>/g);
      if (castLinks) {
        cast = castLinks
          .map((link) => {
            const nameMatch = link.match(/>([^<]+)</);
            return nameMatch ? nameMatch[1].trim() : "";
          })
          .filter(Boolean);
      }
    }

    // 提取演员照片（从 celebrities 区域）
    const celebrities = [];

    const celebritiesSection = html.match(
      /<div id="celebrities"[\s\S]*?<ul class="celebrities-list[^"]*">([\s\S]*?)<\/ul>/
    );
    if (celebritiesSection) {
      const celebrityItems = celebritiesSection[1].match(
        /<li class="celebrity">[\s\S]*?<\/li>/g
      );
      if (celebrityItems) {
        celebrityItems.forEach((item) => {
          const linkMatch = item.match(
            /<a href="https:\/\/www\.douban\.com\/(personage|celebrity)\/(\d+)\/[^"]*"\s+title="([^"]+)"/
          );

          let avatarUrl = "";

          // 方法 1: CSS 背景图
          const bgMatch = item.match(/background-image:\s*url\(([^)]+)\)/);
          if (bgMatch) {
            avatarUrl = bgMatch[1].replace(/^['"]|['"]$/g, "");
          }

          // 方法 2: IMG 标签
          if (!avatarUrl) {
            const imgMatch = item.match(/<img[^>]*src="([^"]+)"/);
            if (imgMatch) {
              avatarUrl = imgMatch[1];
            }
          }

          // 方法 3: data-src 属性
          if (!avatarUrl) {
            const dataSrcMatch = item.match(/data-src="([^"]+)"/);
            if (dataSrcMatch) {
              avatarUrl = dataSrcMatch[1];
            }
          }

          const roleMatch = item.match(
            /<span class="role"[^>]*>([^<]+)<\/span>/
          );

          if (linkMatch && avatarUrl) {
            avatarUrl = avatarUrl.trim().replace(/^http:/, "https:");

            // 高清图替换
            const largeUrl = avatarUrl
              .replace(/\/s\//, "/l/")
              .replace(/\/m\//, "/l/")
              .replace("/s_ratio/", "/l_ratio/")
              .replace("/m_ratio/", "/l_ratio/")
              .replace("/small/", "/large/")
              .replace("/medium/", "/large/");

            const isDefaultAvatar =
              avatarUrl.includes("personage-default") ||
              avatarUrl.includes("celebrity-default") ||
              avatarUrl.includes("has_douban");

            if (!isDefaultAvatar) {
              celebrities.push({
                id: linkMatch[2],
                name: linkMatch[3].split(" ")[0],
                avatar: avatarUrl,
                role: roleMatch ? roleMatch[1].trim() : "",
                avatars: {
                  small: largeUrl
                    .replace("/l/", "/s/")
                    .replace("/l_ratio/", "/s_ratio/")
                    .replace("/large/", "/small/"),
                  medium: largeUrl
                    .replace("/l/", "/m/")
                    .replace("/l_ratio/", "/m_ratio/")
                    .replace("/large/", "/medium/"),
                  large: largeUrl,
                },
              });
            }
          }
        });
      }
    }

    return {
      code: 200,
      message: "获取成功",
      data: {
        id,
        title,
        cast,
        celebrities,
        actors: celebrities.filter((c) => !c.role.includes("导演")),
      },
    };
  } catch (error) {
    throw new Error(
      `解析豆瓣详情页面失败: ${
        error instanceof Error ? error.message : "未知错误"
      }`
    );
  }
}

export async function GET(request) {
  try {
    const {searchParams} = new URL(request.url);
    const doubanId = searchParams.get("id");

    if (!doubanId) {
      return NextResponse.json(
        {code: 400, error: "缺少豆瓣ID参数"},
        {status: 400}
      );
    }

    const target = `https://movie.douban.com/subject/${doubanId}/`;

    // 获取随机浏览器指纹
    const {ua, browser, platform} = getRandomUserAgentWithInfo();
    const secChHeaders = getSecChUaHeaders(browser, platform);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(target, {
      signal: controller.signal,
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "max-age=0",
        DNT: "1",
        ...secChHeaders,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": ua,
        Referer: "https://www.douban.com/",
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return NextResponse.json(
        {code: response.status, error: `豆瓣请求失败: ${response.status}`},
        {status: response.status}
      );
    }

    const html = await response.text();
    const result = parseDoubanDetails(html, doubanId);

    return NextResponse.json(result, {
      headers: {
        "Cache-Control":
          "public, s-maxage=86400, stale-while-revalidate=604800",
      },
    });
  } catch (error) {
    console.error("豆瓣详情API错误:", error);

    if (error.name === "AbortError") {
      return NextResponse.json({code: 504, error: "请求超时"}, {status: 504});
    }

    return NextResponse.json(
      {code: 500, error: error.message || "服务器错误"},
      {status: 500}
    );
  }
}
