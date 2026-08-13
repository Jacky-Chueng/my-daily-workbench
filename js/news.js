/* =====================================================================
   news.js — 每日国际新闻模块（中文 · 6 则）
   ---------------------------------------------------------------------
   通过 rss2json 服务获取中文 RSS（中新网/新华网/人民网等），
   支持页面顶部下拉框切换新闻源。
   全部内容以中文展示。
   ===================================================================== */

const News = (() => {
    const CFG = window.APP_CONFIG;
    const SOURCE_KEY = "dw_news_source";
    let currentSource = localStorage.getItem(SOURCE_KEY) || "chinanews";

    const els = {
        list: () => document.getElementById("newsList"),
        sourceSel: () => document.getElementById("newsSource")
    };

    /* ---------- 通过 rss2json 获取中文新闻 ---------- */
    async function fetchNews(sourceKey) {
        const src = CFG.newsSources[sourceKey];
        if (!src) throw new Error("未知新闻来源");

        const url = CFG.rss2json + encodeURIComponent(src.feed);
        const data = await Api.fetchJson(url, { useProxy: false });

        if (data && data.status === "ok" && data.items && data.items.length) {
            return data.items.slice(0, CFG.newsCount).map(item => ({
                title: item.title || "",
                description: stripTags(item.description || "").slice(0, 120),
                url: item.link || "#",
                pubDate: item.pubDate || "",
                source: src.name
            }));
        }
        throw new Error(`获取 ${src.name} 失败`);
    }

    function stripTags(html) {
        const tmp = document.createElement("div");
        tmp.innerHTML = html;
        return (tmp.textContent || "").replace(/\s+/g, " ").trim();
    }

    /* ---------- 渲染 ---------- */
    function render(items) {
        if (!items || !items.length) {
            renderFallback();
            return;
        }
        els.list().innerHTML = items.map(n => `
            <li class="news-item">
                <a href="${n.url}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
                ${n.description ? `<div class="news-desc">${escapeHtml(n.description)}…</div>` : ""}
                <div class="news-source">
                    📰 ${escapeHtml(n.source)}
                    ${n.pubDate ? ` · ${escapeHtml(n.pubDate.slice(5, 16))}` : ""}
                </div>
            </li>
        `).join("");
    }

    /* ---------- 示例数据 ---------- */
    function renderFallback() {
        const samples = [
            { title: "多国领导人在气候峰会上讨论新一轮减排目标", description: "各国代表就明年最后期限前的排放目标进行谈判", source: "示例数据", url: "#", pubDate: "" },
            { title: "全球主要科技公司宣布人工智能安全合作伙伴关系", description: "多家领先企业同意共享安全研究并建立通用标准", source: "示例数据", url: "#", pubDate: "" },
            { title: "研究人员报告可再生能源存储技术取得突破", description: "新型电池技术有望大幅降低太阳能存储成本", source: "示例数据", url: "#", pubDate: "" },
            { title: "国际援助抵达受自然灾害影响的地区", description: "救援组织向灾区社区运送了急需物资", source: "示例数据", url: "#", pubDate: "" },
            { title: "多国央行在经济不确定性中调整利率", description: "决策者援引通胀担忧和增长放缓做出最新决定", source: "示例数据", url: "#", pubDate: "" },
            { title: "三国签署新贸易协定", description: "该协议旨在降低关税并加强区域经济合作", source: "示例数据", url: "#", pubDate: "" }
        ];
        render(samples);
    }

    /* ---------- 加载 ---------- */
    async function load() {
        els.list().innerHTML = '<li class="loading-text">新闻加载中…</li>';
        try {
            const items = await fetchNews(currentSource);
            render(items);
        } catch (e) {
            console.warn("新闻获取失败:", e);
            // 尝试其他源
            for (const key of Object.keys(CFG.newsSources)) {
                if (key === currentSource) continue;
                try {
                    currentSource = key;
                    const items = await fetchNews(key);
                    if (els.sourceSel()) els.sourceSel().value = key;
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
