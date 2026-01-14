"use client";

import { useState, useEffect, useRef } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import Artplayer from "artplayer";
import Hls from "hls.js";
import artplayerPluginDanmuku from "artplayer-plugin-danmuku";
import artplayerPluginLiquidGlass from "@/lib/artplayer-plugin-liquid-glass";
import { FavoriteButton } from "@/components/FavoriteButton";
import { EpisodeList } from "@/components/EpisodeList";
import { getVideoDetail } from "@/lib/cmsApi";
import { useSettingsStore } from "@/store/useSettingsStore";
import { usePlayHistoryStore } from "@/store/usePlayHistoryStore";
import { fetchDanmakuFromSources } from "@/lib/danmakuApi";
import { extractEpisodeNumberFromTitle, formatTime } from "@/lib/util";
import { scrapeDoubanDetails } from "@/lib/getDouban";

// ============================================================================
// 辅助函数
// ============================================================================

// 去广告功能：过滤 M3U8 中的广告片段
function filterAdsFromM3U8(m3u8Content) {
  if (!m3u8Content) return "";

  const lines = m3u8Content.split("\n");
  const filteredLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 只过滤#EXT-X-DISCONTINUITY标识（通常用于广告分段）
    if (!line.includes("#EXT-X-DISCONTINUITY")) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join("\n");
}

// ============================================================================
// 主组件
// ============================================================================

export default function PlayerPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id;
  const source = searchParams.get("source");

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------
  const [videoDetail, setVideoDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(0);
  const [danmaku, setDanmaku] = useState([]);
  const [doubanActors, setDoubanActors] = useState([]);

  // -------------------------------------------------------------------------
  // 播放器相关的 Refs
  // -------------------------------------------------------------------------
  const artRef = useRef(null); // 播放器容器 DOM 引用
  const artPlayerRef = useRef(null); // Artplayer 实例引用
  const danmakuPluginRef = useRef(null); // 弹幕插件实例引用
  const hasLoadedFirstDanmaku = useRef(false); // 追踪是否已首次加载弹幕

  // 配置状态引用（避免重新渲染）
  const blockAdEnabledRef = useRef(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("enable_blockad");
      return saved !== null ? saved === "true" : true;
    }
    return true;
  });
  const skipConfigRef = useRef(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("skip_config");
      if (saved) {
        try {
          return JSON.parse(saved);
        } catch {
          return { enable: false, intro_time: 0, outro_time: 0 };
        }
      }
    }
    return { enable: false, intro_time: 0, outro_time: 0 };
  });

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);

  // 播放进度相关
  const saveIntervalRef = useRef(null);
  const lastSaveTimeRef = useRef(0);

  // 用于记录是否需要在播放器 ready 后跳转到指定进度
  const resumeTimeRef = useRef(null);

  // 上次使用的音量和播放速率
  const lastVolumeRef = useRef(0.7);
  const lastPlaybackRateRef = useRef(1.0);

  // 数据引用（用于事件回调中访问最新值）
  const videoDetailRef = useRef(videoDetail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);

  useEffect(() => {
    videoDetailRef.current = videoDetail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
  }, [videoDetail, currentEpisodeIndex]);

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------
  const addPlayRecord = usePlayHistoryStore((state) => state.addPlayRecord);
  const getPlayRecord = usePlayHistoryStore((state) => state.getPlayRecord);
  const danmakuSources = useSettingsStore((state) => state.danmakuSources);

  // -------------------------------------------------------------------------
  // 计算当前剧集信息
  // -------------------------------------------------------------------------
  const currentEpisodeUrl = videoDetail?.episodes?.[currentEpisodeIndex] || "";
  const currentEpisodeTitle =
    videoDetail?.episodes_titles?.[currentEpisodeIndex] ||
    `第 ${currentEpisodeIndex + 1} 集`;

  // -------------------------------------------------------------------------
  // 辅助函数
  // -------------------------------------------------------------------------

  // 初始化配置引用
  useEffect(() => {
    if (typeof window !== "undefined") {
      const savedBlockAd = localStorage.getItem("enable_blockad");
      blockAdEnabledRef.current =
        savedBlockAd !== null ? savedBlockAd === "true" : true;

      const savedSkipConfig = localStorage.getItem("skip_config");
      if (savedSkipConfig) {
        try {
          skipConfigRef.current = JSON.parse(savedSkipConfig);
        } catch {
          skipConfigRef.current = {
            enable: false,
            intro_time: 0,
            outro_time: 0,
          };
        }
      } else {
        skipConfigRef.current = { enable: false, intro_time: 0, outro_time: 0 };
      }
    }
  }, []);

  // 保存跳过配置到 localStorage
  const saveSkipConfig = (config) => {
    skipConfigRef.current = config;
    if (typeof window !== "undefined") {
      localStorage.setItem("skip_config", JSON.stringify(config));
    }
  };

  // 保存播放进度函数
  const savePlayProgress = () => {
    if (!artPlayerRef.current || !videoDetailRef.current || !id || !source)
      return;

    const currentTime = artPlayerRef.current.currentTime || 0;
    const duration = artPlayerRef.current.duration || 0;

    if (currentTime < 1 || !duration) return;

    try {
      addPlayRecord({
        source,
        id,
        title: videoDetailRef.current.title,
        poster: videoDetailRef.current.poster,
        year: videoDetailRef.current.year,
        currentEpisodeIndex: currentEpisodeIndexRef.current,
        totalEpisodes: videoDetailRef.current.episodes?.length || 1,
        currentTime,
        duration,
      });
      console.log("播放进度已保存:", {
        title: videoDetailRef.current.title,
        episode: currentEpisodeIndexRef.current + 1,
        progress: `${Math.floor(currentTime)}/${Math.floor(duration)}`,
      });
    } catch (err) {
      console.error("保存播放进度失败:", err);
    }
  };

  // 清理播放器资源
  const cleanupPlayer = () => {
    if (artPlayerRef.current) {
      try {
        if (artPlayerRef.current.video && artPlayerRef.current.video.hls) {
          artPlayerRef.current.video.hls.destroy();
        }
        artPlayerRef.current.destroy();
        artPlayerRef.current = null;
        danmakuPluginRef.current = null;
        console.log("播放器资源已清理");
      } catch (err) {
        console.warn("清理播放器资源时出错:", err);
        artPlayerRef.current = null;
      }
    }
  };

  // 自定义 HLS Loader，用于去广告
  class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context, config, callbacks) {
        if (context.type === "manifest" || context.type === "level") {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (response, stats, context) {
            if (response.data && typeof response.data === "string") {
              response.data = filterAdsFromM3U8(response.data);
            }
            return onSuccess(response, stats, context, null);
          };
        }
        load(context, config, callbacks);
      };
    }
  }

  // -------------------------------------------------------------------------
  // 获取视频详情
  // -------------------------------------------------------------------------
  useEffect(() => {
    async function fetchVideoDetail() {
      if (!id || !source) {
        setError("缺少必要的参数");
        setLoading(false);
        return;
      }

      const videoSources = useSettingsStore.getState().videoSources;
      const sourceConfig = videoSources.find((s) => s.key === source);
      if (!sourceConfig) {
        setError("未找到对应的视频源");
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const detail = await getVideoDetail(
          id,
          sourceConfig.name,
          sourceConfig.url
        );
        setVideoDetail(detail);
      } catch (err) {
        console.error("获取视频详情失败:", err);
        setError("获取视频详情失败，请稍后重试");
      } finally {
        setLoading(false);
      }
    }

    fetchVideoDetail();
  }, [id, source]);

  // -------------------------------------------------------------------------
  // 获取弹幕数据
  // -------------------------------------------------------------------------
  useEffect(() => {
    async function loadDanmaku() {
      if (!videoDetail || !videoDetail.douban_id) {
        console.log("没有豆瓣ID，无法获取弹幕");
        setDanmaku([]);
        return;
      }

      const enabledSources = danmakuSources.filter((s) => s.enabled);
      if (enabledSources.length === 0) {
        console.log("没有启用的弹幕源");
        setDanmaku([]);
        return;
      }

      try {
        const isMovie = videoDetail.episodes?.length === 1;
        const episodeTitle =
          videoDetail.episodes_titles?.[currentEpisodeIndex] ||
          `第${currentEpisodeIndex + 1}集`;

        let episodeNumber = extractEpisodeNumberFromTitle(
          episodeTitle,
          isMovie
        );

        if (episodeNumber === null) {
          episodeNumber = currentEpisodeIndex + 1;
          console.warn(
            `无法从标题 "${episodeTitle}" 中提取集数，使用索引 ${episodeNumber}`
          );
        }

        console.log(
          `获取弹幕: 豆瓣ID=${
            videoDetail.douban_id
          }, 标题="${episodeTitle}", 集数=${episodeNumber}${
            isMovie ? " (电影)" : ""
          }`
        );

        const danmakuData = await fetchDanmakuFromSources(
          danmakuSources,
          videoDetail.douban_id,
          episodeNumber
        );

        setDanmaku(danmakuData);
        console.log(`弹幕加载完成，共 ${danmakuData.length} 条`);
      } catch (error) {
        console.error("获取弹幕失败:", error);
        setDanmaku([]);
      }
    }

    loadDanmaku();
  }, [videoDetail, currentEpisodeIndex, danmakuSources]);

  // -------------------------------------------------------------------------
  // 获取豆瓣演员数据（带头像）
  // -------------------------------------------------------------------------
  useEffect(() => {
    async function loadDoubanActors() {
      if (!videoDetail || !videoDetail.douban_id) {
        setDoubanActors([]);
        return;
      }

      try {
        console.log(`获取豆瓣演员数据: 豆瓣ID=${videoDetail.douban_id}`);
        const result = await scrapeDoubanDetails(videoDetail.douban_id);
        
        if (result.code === 200 && result.data.actors) {
          // 豆瓣图片代理
          result.data.actors.forEach((actor) => {
            actor.avatar = actor.avatar.replace(/img\d+\.doubanio\.com/g, "img.doubanio.cmliussss.com");
          });
          setDoubanActors(result.data.actors);
          console.log(`豆瓣演员数据加载完成，共 ${result.data.actors.length} 位演员`);
        }
      } catch (error) {
        console.warn("获取豆瓣演员数据失败:", error.message);
        setDoubanActors([]);
      }
    }

    loadDoubanActors();
  }, [videoDetail]);

  // -------------------------------------------------------------------------
  // 播放器初始化和 URL 切换
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!currentEpisodeUrl || loading || !artRef.current) {
      return;
    }

    // 检测是否为 WebKit 浏览器（Safari）
    const isWebkit =
      typeof window !== "undefined" &&
      typeof window.webkitConvertPointFromNodeToPage === "function";

    // 非 WebKit 浏览器且播放器已存在，使用 switch 方法切换
    if (!isWebkit && artPlayerRef.current) {
      console.log("使用 switch 方法切换视频:", currentEpisodeUrl);
      artPlayerRef.current.switchUrl(currentEpisodeUrl);
      artPlayerRef.current.title = videoDetail
        ? `${videoDetail.title} - ${currentEpisodeTitle}`
        : "";
      artPlayerRef.current.poster =
        videoDetail?.backdrop || videoDetail?.poster || "";
      return;
    }

    // WebKit 浏览器或首次创建：销毁之前的播放器实例并创建新的
    if (artPlayerRef.current) {
      cleanupPlayer();
    }

    // 重置弹幕加载标志
    hasLoadedFirstDanmaku.current = false;

    try {
      console.log("创建新的播放器实例:", currentEpisodeUrl);

      artPlayerRef.current = new Artplayer({
        container: artRef.current,
        url: currentEpisodeUrl,
        poster: videoDetail?.backdrop || videoDetail?.poster || "",
        title: videoDetail
          ? `${videoDetail.title} - ${currentEpisodeTitle}`
          : "",
        volume: lastVolumeRef.current,
        isLive: false,
        muted: false,
        autoplay: true,
        pip: true,
        autoSize: false,
        autoMini: false,
        screenshot: false,
        setting: true,
        loop: false,
        flip: false,
        playbackRate: true,
        aspectRatio: false,
        fullscreen: true,
        fullscreenWeb: true,
        subtitleOffset: false,
        miniProgressBar: false,
        mutex: true,
        playsInline: true,
        autoPlayback: false,
        airplay: true,
        theme: "#FAC638",
        lang: "zh-cn",
        hotkey: false,
        fastForward: true,
        autoOrientation: true,
        lock: true,
        moreVideoAttr: {
          crossOrigin: "anonymous",
        },

        // 弹幕插件
        plugins: [
          artplayerPluginDanmuku({
            danmuku: danmaku,
            speed: 7.5,
            opacity: 1,
            fontSize: 23,
            emitter: false,
            color: "#FFFFFF",
            mode: 0,
            margin: [10, "25%"],
            antiOverlap: true,
            useWorker: true,
            synchronousPlayback: true,
            filter: (danmu) => danmu.text.length <= 50,
            lockTime: 5,
            maxLength: 100,
            minWidth: 200,
            maxWidth: 400,
            theme: "dark",
          }),
          artplayerPluginLiquidGlass(),
        ],

        // HLS 支持配置
        customType: {
          m3u8: function (video, url) {
            // 检查浏览器是否原生支持 HLS（如 Safari）
            if (
              video.canPlayType("application/vnd.apple.mpegurl") ||
              video.canPlayType("application/x-mpegurl")
            ) {
              console.log("使用原生 HLS 播放");
              video.src = url;
              return;
            }

            // 检查 HLS.js 是否支持
            if (!Hls || !Hls.isSupported()) {
              console.warn("HLS.js 不支持，尝试原生播放");
              video.src = url;
              return;
            }

            console.log("使用 HLS.js 播放");

            if (video.hls) {
              video.hls.destroy();
            }

            const hls = new Hls({
              debug: false,
              enableWorker: true,
              lowLatencyMode: true,
              maxBufferLength: 30,
              backBufferLength: 30,
              maxBufferSize: 60 * 1000 * 1000,
              loader: blockAdEnabledRef.current
                ? CustomHlsJsLoader
                : Hls.DefaultConfig.loader,
            });

            hls.loadSource(url);
            hls.attachMedia(video);
            video.hls = hls;

            hls.on(Hls.Events.ERROR, function (event, data) {
              if (data.fatal) {
                console.error("HLS 致命错误:", data.type, data.details);
                switch (data.type) {
                  case Hls.ErrorTypes.NETWORK_ERROR:
                    console.log("网络错误，尝试恢复...");
                    hls.startLoad();
                    break;
                  case Hls.ErrorTypes.MEDIA_ERROR:
                    console.log("媒体错误，尝试恢复...");
                    hls.recoverMediaError();
                    break;
                  default:
                    console.log("无法恢复的错误，回退到原生播放");
                    hls.destroy();
                    video.src = url;
                    break;
                }
              } else {
                console.warn("HLS 非致命错误:", data.details);
              }
            });
          },
        },

        // 设置面板配置
        settings: [
          {
            html: "去广告",
            icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="50%" font-size="14" font-weight="bold" text-anchor="middle" dominant-baseline="middle" fill="currentColor">AD</text></svg>',
            tooltip: blockAdEnabledRef.current ? "已开启" : "已关闭",
            switch: blockAdEnabledRef.current,
            onSwitch: function (item) {
              const newVal = !item.switch;
              blockAdEnabledRef.current = newVal;

              if (typeof window !== "undefined") {
                localStorage.setItem("enable_blockad", String(newVal));
              }

              if (artPlayerRef.current) {
                artPlayerRef.current.notice.show = newVal
                  ? "去广告已开启，刷新生效"
                  : "去广告已关闭，刷新生效";
              }

              return newVal;
            },
          },
          {
            html: "跳过片头片尾",
            tooltip: skipConfigRef.current.enable ? "已开启" : "已关闭",
            switch: skipConfigRef.current.enable,
            onSwitch: function (item) {
              const newConfig = {
                ...skipConfigRef.current,
                enable: !item.switch,
              };
              saveSkipConfig(newConfig);

              if (artPlayerRef.current) {
                artPlayerRef.current.notice.show = newConfig.enable
                  ? "跳过片头片尾已开启"
                  : "跳过片头片尾已关闭";
              }

              return !item.switch;
            },
          },
          {
            html: "设置片头",
            icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="6" cy="12" r="2" fill="currentColor"/><path d="M10 12L17 12" stroke="currentColor" stroke-width="2"/><path d="M17 7L17 17" stroke="currentColor" stroke-width="2"/></svg>',
            tooltip:
              skipConfigRef.current.intro_time === 0
                ? "点击设置片头时间"
                : `片头：${formatTime(skipConfigRef.current.intro_time)}`,
            onClick: function () {
              if (artPlayerRef.current) {
                const currentTime = artPlayerRef.current.currentTime || 0;
                if (currentTime > 0) {
                  const newConfig = {
                    ...skipConfigRef.current,
                    intro_time: currentTime,
                  };
                  saveSkipConfig(newConfig);
                  artPlayerRef.current.notice.show = `片头已设置：${formatTime(
                    currentTime
                  )}`;
                  return `片头：${formatTime(currentTime)}`;
                }
              }
            },
          },
          {
            html: "设置片尾",
            icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 7L7 17" stroke="currentColor" stroke-width="2"/><path d="M7 12L14 12" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="12" r="2" fill="currentColor"/></svg>',
            tooltip:
              skipConfigRef.current.outro_time >= 0
                ? "点击设置片尾时间"
                : `片尾：${formatTime(-skipConfigRef.current.outro_time)}`,
            onClick: function () {
              if (artPlayerRef.current) {
                const outroTime =
                  -(
                    artPlayerRef.current.duration -
                    artPlayerRef.current.currentTime
                  ) || 0;
                if (outroTime < 0) {
                  const newConfig = {
                    ...skipConfigRef.current,
                    outro_time: outroTime,
                  };
                  saveSkipConfig(newConfig);
                  artPlayerRef.current.notice.show = `片尾已设置：${formatTime(
                    -outroTime
                  )}`;
                  return `片尾：${formatTime(-outroTime)}`;
                }
              }
            },
          },
          {
            html: "清除跳过配置",
            icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 18L18 6M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
            onClick: function () {
              const newConfig = { enable: false, intro_time: 0, outro_time: 0 };
              saveSkipConfig(newConfig);

              if (artPlayerRef.current) {
                artPlayerRef.current.notice.show = "跳过配置已清除";
              }

              return "已清除";
            },
          },
        ],

        // 控制栏：下一集按钮
        controls: [
          {
            position: "right",
            index: 10,
            html: '<button class="art-icon art-icon-next" style="display: flex; align-items: center; justify-content: center;"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg></button>',
            tooltip: "下一集",
            click: function () {
              const detail = videoDetailRef.current;
              const idx = currentEpisodeIndexRef.current;
              if (
                detail &&
                detail.episodes &&
                idx < detail.episodes.length - 1
              ) {
                setCurrentEpisodeIndex(idx + 1);
              }
            },
          },
        ],
      });

      // 保存弹幕插件实例
      if (
        artPlayerRef.current.plugins &&
        artPlayerRef.current.plugins.artplayerPluginDanmuku
      ) {
        danmakuPluginRef.current =
          artPlayerRef.current.plugins.artplayerPluginDanmuku;
      }

      // 监听播放器事件
      artPlayerRef.current.on("ready", () => {
        console.log("播放器就绪");
        setError(null);
      });

      // 监听音量和播放速率变化
      artPlayerRef.current.on("video:volumechange", () => {
        lastVolumeRef.current = artPlayerRef.current.volume;
      });

      artPlayerRef.current.on("video:ratechange", () => {
        lastPlaybackRateRef.current = artPlayerRef.current.playbackRate;
      });

      // 监听视频可播放事件，恢复播放进度
      artPlayerRef.current.on("video:canplay", () => {
        if (resumeTimeRef.current && resumeTimeRef.current > 0) {
          try {
            const duration = artPlayerRef.current.duration || 0;
            let target = resumeTimeRef.current;
            if (duration && target >= duration - 2) {
              target = Math.max(0, duration - 5);
            }
            artPlayerRef.current.currentTime = target;
            artPlayerRef.current.notice.show = `已恢复到 ${Math.floor(
              target / 60
            )}:${String(Math.floor(target % 60)).padStart(2, "0")}`;
            console.log("成功恢复播放进度到:", target);
          } catch (err) {
            console.warn("恢复播放进度失败:", err);
          }
        }
        resumeTimeRef.current = null;

        // 恢复音量和播放速率
        setTimeout(() => {
          if (
            Math.abs(artPlayerRef.current.volume - lastVolumeRef.current) > 0.01
          ) {
            artPlayerRef.current.volume = lastVolumeRef.current;
          }
          if (
            Math.abs(
              artPlayerRef.current.playbackRate - lastPlaybackRateRef.current
            ) > 0.01 &&
            isWebkit
          ) {
            artPlayerRef.current.playbackRate = lastPlaybackRateRef.current;
          }
        }, 0);
      });

      // 监听视频时间更新事件，实现跳过片头片尾
      artPlayerRef.current.on("video:timeupdate", () => {
        if (!skipConfigRef.current.enable) return;

        const currentTime = artPlayerRef.current.currentTime || 0;
        const duration = artPlayerRef.current.duration || 0;
        const now = Date.now();

        // 限制跳过检查频率为1.5秒一次
        if (now - lastSkipCheckRef.current < 1500) return;
        lastSkipCheckRef.current = now;

        // 跳过片头
        if (
          skipConfigRef.current.intro_time > 0 &&
          currentTime < skipConfigRef.current.intro_time
        ) {
          artPlayerRef.current.currentTime = skipConfigRef.current.intro_time;
          artPlayerRef.current.notice.show = `已跳过片头 (${formatTime(
            skipConfigRef.current.intro_time
          )})`;
        }

        // 跳过片尾
        if (
          skipConfigRef.current.outro_time < 0 &&
          duration > 0 &&
          currentTime > duration + skipConfigRef.current.outro_time
        ) {
          artPlayerRef.current.notice.show = `已跳过片尾 (${formatTime(
            -skipConfigRef.current.outro_time
          )})`;
          // 触发下一集或暂停
          const detail = videoDetailRef.current;
          const idx = currentEpisodeIndexRef.current;
          if (detail && detail.episodes && idx < detail.episodes.length - 1) {
            setCurrentEpisodeIndex(idx + 1);
          } else {
            artPlayerRef.current.pause();
          }
        }
      });

      // 定期保存播放进度
      artPlayerRef.current.on("video:timeupdate", () => {
        const now = Date.now();
        if (now - lastSaveTimeRef.current > 5000) {
          savePlayProgress();
          lastSaveTimeRef.current = now;
        }
      });

      // 暂停时保存进度
      artPlayerRef.current.on("pause", () => {
        savePlayProgress();
      });

      // 视频播放结束时自动播放下一集
      artPlayerRef.current.on("video:ended", () => {
        const detail = videoDetailRef.current;
        const idx = currentEpisodeIndexRef.current;
        if (detail && detail.episodes && idx < detail.episodes.length - 1) {
          setTimeout(() => {
            setCurrentEpisodeIndex(idx + 1);
          }, 1000);
        }
      });

      artPlayerRef.current.on("error", (err) => {
        console.error("播放器错误:", err);
      });
    } catch (err) {
      console.error("创建播放器失败:", err);
      setError("播放器初始化失败");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEpisodeUrl, loading]);

  // -------------------------------------------------------------------------
  // 弹幕动态更新
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!danmakuPluginRef.current || !artPlayerRef.current) return;

    if (danmaku.length === 0) {
      if (hasLoadedFirstDanmaku.current) {
        console.log("清空弹幕");
        if (typeof danmakuPluginRef.current.reset === "function") {
          danmakuPluginRef.current.reset();
        }
      }
      return;
    }

    if (typeof danmakuPluginRef.current.load === "function") {
      if (!hasLoadedFirstDanmaku.current) {
        console.log("首次加载弹幕，共", danmaku.length, "条");
        hasLoadedFirstDanmaku.current = true;
      } else {
        console.log("重新加载弹幕，共", danmaku.length, "条");
      }

      danmakuPluginRef.current.reset();
      danmakuPluginRef.current.config({
        danmuku: danmaku,
      });
      danmakuPluginRef.current.load();

      if (artPlayerRef.current && artPlayerRef.current.notice) {
        artPlayerRef.current.notice.show = `已加载 ${danmaku.length} 条弹幕`;
      }
    } else {
      console.warn("弹幕插件不支持 load 方法，无法动态更新弹幕");
    }
  }, [danmaku]);

  // -------------------------------------------------------------------------
  // 恢复播放进度
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!videoDetail || !id || !source) return;

    const playRecord = getPlayRecord(source, id);
    if (playRecord && playRecord.currentEpisodeIndex === currentEpisodeIndex) {
      const targetTime = playRecord.currentTime;
      if (targetTime > 5) {
        resumeTimeRef.current = targetTime;
        console.log("将恢复播放进度:", targetTime);
      }
    }
  }, [videoDetail, id, source, currentEpisodeIndex, getPlayRecord]);

  // -------------------------------------------------------------------------
  // 键盘快捷键
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyboardShortcuts = (e) => {
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;

      const detail = videoDetailRef.current;
      const idx = currentEpisodeIndexRef.current;

      // Alt + 左箭头 = 上一集
      if (e.altKey && e.key === "ArrowLeft") {
        if (detail && idx > 0) {
          setCurrentEpisodeIndex(idx - 1);
          e.preventDefault();
        }
      }

      // Alt + 右箭头 = 下一集
      if (e.altKey && e.key === "ArrowRight") {
        if (detail && detail.episodes && idx < detail.episodes.length - 1) {
          setCurrentEpisodeIndex(idx + 1);
          e.preventDefault();
        }
      }

      // 左箭头 = 快退
      if (!e.altKey && e.key === "ArrowLeft") {
        if (artPlayerRef.current && artPlayerRef.current.currentTime > 5) {
          artPlayerRef.current.currentTime -= 10;
          e.preventDefault();
        }
      }

      // 右箭头 = 快进
      if (!e.altKey && e.key === "ArrowRight") {
        if (
          artPlayerRef.current &&
          artPlayerRef.current.currentTime < artPlayerRef.current.duration - 5
        ) {
          artPlayerRef.current.currentTime += 10;
          e.preventDefault();
        }
      }

      // 上箭头 = 音量+
      if (e.key === "ArrowUp") {
        if (artPlayerRef.current && artPlayerRef.current.volume < 1) {
          artPlayerRef.current.volume =
            Math.round((artPlayerRef.current.volume + 0.1) * 10) / 10;
          artPlayerRef.current.notice.show = `音量: ${Math.round(
            artPlayerRef.current.volume * 100
          )}`;
          e.preventDefault();
        }
      }

      // 下箭头 = 音量-
      if (e.key === "ArrowDown") {
        if (artPlayerRef.current && artPlayerRef.current.volume > 0) {
          artPlayerRef.current.volume =
            Math.round((artPlayerRef.current.volume - 0.1) * 10) / 10;
          artPlayerRef.current.notice.show = `音量: ${Math.round(
            artPlayerRef.current.volume * 100
          )}`;
          e.preventDefault();
        }
      }

      // 空格 = 播放/暂停
      if (e.key === " ") {
        if (artPlayerRef.current) {
          artPlayerRef.current.toggle();
          e.preventDefault();
        }
      }

      // f 键 = 切换全屏
      if (e.key === "f" || e.key === "F") {
        if (artPlayerRef.current) {
          artPlayerRef.current.fullscreen = !artPlayerRef.current.fullscreen;
          e.preventDefault();
        }
      }
    };

    document.addEventListener("keydown", handleKeyboardShortcuts);
    return () => {
      document.removeEventListener("keydown", handleKeyboardShortcuts);
    };
  }, []);

  // -------------------------------------------------------------------------
  // 页面卸载前保存播放进度
  // -------------------------------------------------------------------------
  useEffect(() => {
    const handleBeforeUnload = () => {
      savePlayProgress();
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      savePlayProgress();
    };
  }, []);

  // -------------------------------------------------------------------------
  // 组件卸载时清理播放器
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (saveIntervalRef.current) {
        clearInterval(saveIntervalRef.current);
      }
      cleanupPlayer();
    };
  }, []);

  // -------------------------------------------------------------------------
  // 切换剧集
  // -------------------------------------------------------------------------
  const handleEpisodeClick = (index) => {
    setCurrentEpisodeIndex(index);
  };

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="w-full max-w-7xl pt-4 flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-primary border-t-transparent"></div>
          <p className="text-gray-500">加载中...</p>
        </div>
      </div>
    );
  }

  if (error || !videoDetail) {
    return (
      <div className="w-full max-w-7xl pt-4 flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4">
          <span className="material-symbols-outlined text-6xl text-gray-300">
            error
          </span>
          <p className="text-gray-500">{error || "未找到视频"}</p>
          <Link href="/" className="text-primary hover:underline">
            返回首页
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-7xl pt-4">
      <nav aria-label="Breadcrumb" className="flex mb-6 text-sm text-gray-500">
        <ol className="inline-flex items-center space-x-1 md:space-x-3">
          <li className="inline-flex items-center">
            <Link
              href="/"
              className="inline-flex items-center hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-lg mr-1">
                home
              </span>
              首页
            </Link>
          </li>
          <li>
            <div className="flex items-center">
              <span className="material-symbols-outlined text-gray-400">
                chevron_right
              </span>
              <span className="ml-1 md:ml-2 hover:text-primary transition-colors cursor-pointer">
                {videoDetail.type === "movie" ? "电影" : "电视剧"}
              </span>
            </div>
          </li>
          <li>
            <div className="flex items-center">
              <span className="material-symbols-outlined text-gray-400">
                chevron_right
              </span>
              <span className="ml-1 md:ml-2 text-gray-900 font-medium">
                {videoDetail.title}
              </span>
            </div>
          </li>
        </ol>
      </nav>

      <div className="grid grid-cols-1 gap-8 transition-all duration-300 lg:grid-cols-12">
        {/* Left Column: Player and Info */}
        <div className="flex flex-col gap-8 transition-all duration-300 lg:col-span-8">
          <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden shadow-2xl group ring-1 ring-gray-900/5">
            {currentEpisodeUrl ? (
              <div ref={artRef} className="w-full h-full" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-white">
                <span>暂无播放源</span>
              </div>
            )}
          </div>

          <div className="flex flex-col md:flex-row gap-8 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm">
            <div className="hidden md:block w-48 shrink-0">
              <div className="aspect-2/3 rounded-xl overflow-hidden shadow-lg ring-1 ring-gray-900/5 relative group">
                <img
                  alt={`${videoDetail.title} Poster`}
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  src={videoDetail.poster}
                />
              </div>
            </div>
            <div className="flex-1 space-y-5">
              <div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-2">
                  <h1 className="text-3xl font-bold text-gray-900">
                    {videoDetail.title}
                  </h1>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center text-primary h-10">
                      <span className="material-symbols-outlined material-symbols-filled text-xl">
                        star
                      </span>
                      <span className="text-lg font-bold ml-1 leading-none">
                        {videoDetail.rating}
                      </span>
                      <span className="text-gray-400 text-sm font-normal ml-1 leading-none self-end pb-1">
                        / 10
                      </span>
                    </div>
                    <FavoriteButton
                      source={source}
                      id={id}
                      videoDetail={videoDetail}
                    />
                    <button className="flex items-center justify-center h-10 w-10 rounded-full hover:bg-gray-100 text-gray-400 hover:text-blue-500 transition-colors">
                      <span className="material-symbols-outlined">share</span>
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-gray-600 mb-4">
                  <span className="bg-gray-100 px-2 py-1 rounded text-xs font-semibold text-gray-700">
                    {videoDetail.year}
                  </span>
                  <span className="w-1 h-1 bg-gray-300 rounded-full"></span>
                  <span>{videoDetail.genre}</span>
                  {videoDetail.class && (
                    <>
                      <span className="w-1 h-1 bg-gray-300 rounded-full"></span>
                      <span>{videoDetail.type_name}</span>
                    </>
                  )}
                  {videoDetail.episodes.length > 1 && (
                    <>
                      <span className="w-1 h-1 bg-gray-300 rounded-full"></span>
                      <span>全 {videoDetail.episodes.length} 集</span>
                    </>
                  )}
                  <span className="w-1 h-1 bg-gray-300 rounded-full"></span>
                  <span className="text-primary text-xs bg-primary/10 px-2 py-1 rounded">
                    {videoDetail.source || sourceConfig.name}
                  </span>
                </div>
              </div>
              {videoDetail.desc && (
                <div className="prose prose-sm max-w-none text-gray-600">
                  <h3 className="text-gray-900 font-semibold mb-1">剧情简介</h3>
                  <p className="leading-relaxed">{videoDetail.desc}</p>
                </div>
              )}
              {(doubanActors.length > 0 || (videoDetail.actors && videoDetail.actors.length > 0)) && (
                <div>
                  <h3 className="text-gray-900 font-semibold mb-3">演员表</h3>
                  <div className="flex gap-4 overflow-x-auto pb-2 hide-scrollbar">
                    {(doubanActors.length > 0 ? doubanActors : videoDetail.actors).map((actor, idx) => (
                      <div
                        key={actor.id || idx}
                        className="flex flex-col items-center gap-2 min-w-[70px]"
                      >
                        <div className="size-16 rounded-full overflow-hidden border border-gray-200 shadow-sm bg-gray-100 flex items-center justify-center">
                          {actor.avatar ? (
                            <img
                              src={actor.avatar}
                              alt={actor.name}
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                e.target.style.display = 'none';
                                e.target.nextSibling.style.display = 'flex';
                              }}
                            />
                          ) : null}
                          <span 
                            className="material-symbols-outlined text-gray-400 text-2xl"
                            style={{ display: actor.avatar ? 'none' : 'flex' }}
                          >
                            person
                          </span>
                        </div>
                        <span className="text-xs font-medium text-gray-900 text-center truncate w-full">
                          {actor.name}
                        </span>
                        {actor.role && (
                          <span className="text-xs text-gray-500 text-center truncate w-full">
                            {actor.role}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Episodes */}
        <div className="space-y-6 transition-all duration-300 lg:col-span-4">
          <EpisodeList
            episodes={videoDetail.episodes}
            episodesTitles={videoDetail.episodes_titles}
            currentEpisodeIndex={currentEpisodeIndex}
            onEpisodeClick={handleEpisodeClick}
          />
        </div>
      </div>
    </div>
  );
}
