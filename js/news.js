/* =====================================================================
   news.js — 每日要闻模块（中文 · 8 则 · 国内+国际混合 · 按重要性排序）
   ---------------------------------------------------------------------
   通过 rss2json 获取中文 RSS（新华/人民/中新/BBC中文等）。
   每个新闻分组都是「聚合源」：并发抓取多个 feed，去重后按各源编辑
   排序（头条在前 = 最重要）交错混合，使国内/国际均衡且整体按重要性
   排列，最终取前 newsCount 则。
   说明：RSS 源本身由编辑按重要性排好序（头条最前），本模块据此近似
   实现"按重要性排序"；精确的全局重要性排序需后端/模型支持。
   ===================================================================== */

const News = (() => {
    const CFG = window.APP_CONFIG;
    const SOURCE_KEY = "dw_news_source";
    let currentSource = localStorage.getItem(SOURCE_KEY) || "headline";

    const els = {
        list: () => document.getElementById("newsList"),
        sourceSel: () => document.getElementById("newsSource")
    };

    /* ---------- 工具：去 HTML 标签 ---------- */
    function stripTags(html) {
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        return (tmp.textContent || "").replace(/\s+/g, " ").trim();
    }

    function normalize(title) {
        return (title || "").replace(/[\s　·•·\.。，、]/g, "").toLowerCase();
    }

    /* ---------- 单个 feed 抓取（自带超时，避免某源卡死拖垮整体）---------- */
    async function fetchFeed(feedObj) {
        const url = CFG.rss2json + encodeURIComponent(feedObj.feed);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 9000);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) return [];
            const data = await res.json();
            if (data && data.status === "ok" && Array.isArray(data.items)) {
                return data.items.slice(0, 8).map(it => ({
                    title: it.title || "",
                    description: stripTags(it.description || "").slice(0, 90),
                    url: it.link || "#",
                    pubDate: it.pubDate || "",
                    source: feedObj.name,
                    region: feedObj.region || ""
                }));
            }
            return [];
        } catch (e) {
            return [];
        } finally {
            clearTimeout(timer);
        }
    }

    /* ---------- 多源聚合：交错混合（国内/国际均衡）+ 去重 + 取前 N ---------- */
    function mergeRoundRobin(arrays, limit) {
        // 过滤空数组，保留各源顺序（源在 config 中已按重要性排列）
        const queues = arrays.filter(a => a && a.length).map(a => a.slice());
        const out = [];
        const seen = new Set();
        let i = 0;
        while (out.length < limit && queues.length && queues.some(q => q.length)) {
            const q = queues[i % queues.length];
            if (q.length) {
                const it = q.shift();
                const key = normalize(it.title);
                if (key && !seen.has(key)) {
                    seen.add(key);
                    out.push(it);
                }
            }
            i++;
        }
        return out;
    }

    /* ---------- 聚合源加载 ---------- */
    async function fetchAggregate(srcCfg) {
        const results = await Promise.allSettled(srcCfg.feeds.map(fetchFeed));
        const arrays = results
            .filter(r => r.status === "fulfilled")
            .map(r => r.value);
        const merged = mergeRoundRobin(arrays, CFG.newsCount);
        if (!merged.length) throw new Error("所有新闻源均无返回");
        return merged;
    }

    /* ---------- 渲染（含排名序号）---------- */
    function render(items) {
        if (!items || !items.length) {
            renderFallback();
            return;
        }
        els.list().innerHTML = items.map((n, idx) => `
            <li class="news-item">
                <span class="news-rank">${idx + 1}</span>
                <div class="news-body">
                    <a href="${n.url}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
                    ${n.description ? `<div class="news-desc">${escapeHtml(n.description)}…</div>` : ""}
                    <div class="news-source">
                        📰 ${escapeHtml(n.source)}
                        ${n.pubDate ? ` · ${escapeHtml(n.pubDate.slice(5, 16))}` : ""}
                    </div>
                </div>
            </li>
        `).join("");
    }

    /* ---------- 示例数据（全部源失败时）---------- */
    function renderFallback() {
        const samples = [
            { title: "多部门联合发文部署下半年经济重点工作", description: "围绕稳增长、扩内需、惠民生推出一系列举措", source: "示例数据", region: "domestic", url: "#", pubDate: "" },
            { title: "我国科学家在量子计算领域取得重要突破", description: "研究团队实现新架构下的算力跃升", source: "示例数据", region: "domestic", url: "#", pubDate: "" },
            { title: "联合国安理会就国际热点局势召开紧急会议", description: "多国代表呼吁通过对话化解分歧", source: "示例数据", region: "international", url: "#", pubDate: "" },
            { title: "主要经济体公布最新通胀与就业数据", description: "市场密切关注央行后续货币政策走向", source: "示例数据", region: "international", url: "#", pubDate: "" },
            { title: "新版职业教育法实施细则落地", description: "进一步明确产教融合支持政策", source: "示例数据", region: "domestic", url: "#", pubDate: "" },
            { title: "国际航运价格出现明显回落", description: "全球供应链紧张局面持续缓解", source: "示例数据", region: "international", url: "#", pubDate: "" },
            { title: "多地启动夏季防汛与高温应对工作", description: "相关部门加强监测预警和应急值守", source: "示例数据", region: "domestic", url: "#", pubDate: "" },
            { title: "全球人工智能治理框架进入磋商阶段", description: "各方就安全、伦理与标准展开讨论", source: "示例数据", region: "international", url: "#", pubDate: "" }
        ];
        render(samples);
    }

    /* ---------- 加载 ---------- */
    async function load() {
        els.list().innerHTML = '<li class="loading-text">新闻加载中…</li>';
        const srcCfg = CFG.newsSources[currentSource];
        try {
            if (srcCfg && srcCfg.aggregate) {
                const items = await fetchAggregate(srcCfg);
                render(items);
            } else {
                throw new Error("非聚合源暂不支持");
            }
        } catch (e) {
            console.warn("新闻获取失败:", e);
            // TRY 其他聚合分组兜底
            for (const key of Object.keys(CFG.newsSources)) {
                if (key === currentSource) continue;
                const alt = CFG.newsSources[key];
                if (!alt || !alt.aggregate) continue;
                try {
                    const items = await fetchAggregate(alt);
                    if (els.sourceSel()) els.sourceSel().value = key;
                    currentSource = key;
                    render(items);
                    return;
                } catch (e2) {
                    console.warn(`切换到 ${key} 也失败:`, e2);
                }
            }
            renderFallback();
        }
    }

    /* ---------- 切换来源 ---------- */
    async function switchSource(sourceKey) {
        currentSource = sourceKey;
        localStorage.setItem(SOURCE_KEY, sourceKey);
        await load();
    }

    /* ---------- 初始化 ---------- */
    function init() {
        if (els.sourceSel()) {
            els.sourceSel().value = currentSource;
            els.sourceSel().addEventListener("change", e => switchSource(e.target.value));
        }
        load();
    }

    function refresh() { load(); }

    return { init, refresh };
})();
