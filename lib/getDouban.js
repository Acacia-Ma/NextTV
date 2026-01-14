/**
 * 获取豆瓣详情数据（通过 API 路由代理，避免 CORS 问题）
 * borrow from https://github.com/SzeMeng76/LunaTV
 */

/**
 * 从豆瓣获取演员和详情数据
 * @param {string} doubanId - 豆瓣ID
 * @returns {Promise<Object>} 包含演员数据的结果
 */
export async function scrapeDoubanDetails(doubanId) {
  if (!doubanId) {
    return {
      code: 400,
      message: "缺少豆瓣ID",
      data: {actors: [], celebrities: []},
    };
  }

  try {
    // 通过服务器端 API 路由代理请求，避免 CORS
    const response = await fetch(`/api/actor?id=${doubanId}`);

    if (!response.ok) {
      throw new Error(`API请求失败: ${response.status}`);
    }

    const result = await response.json();
    return result;
  } catch (error) {
    console.error("获取豆瓣详情失败:", error);
    return {
      code: 500,
      message: error.message || "请求失败",
      data: {actors: [], celebrities: []},
    };
  }
}
