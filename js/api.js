/* =====================================================================
   api.js — 通用工具与 API 封装
   ---------------------------------------------------------------------
   提供：
   - fetchJson / fetchText        带 CORS 代理的请求封装
   - parseRss                     解析 RSS XML 为文章列表
   - fetchArticleHtml             抓取文章全文 HTML
   - extractParagraphs            从 HTML 中抽取正文段落
   - translateText                调用 LibreTranslate 翻译
   - showToast / formatDate       通用工具
   ===================================================================== */

const Api = (() => {
    const CFG = window.APP_CONFIG;

    /* ---------- 通过 CORS 代理发起请求 ---------- */
    function proxiedUrl(rawUrl) {
        return CFG.corsProxy + encodeURIComponent(rawUrl);
    }

    async function fetchText(rawUrl, { useProxy = true } = {}) {
        const url = useProxy ? proxiedUrl(rawUrl) : rawUrl;
        const res = await fetch(url, { headers: { "Accept": "text/html,application/xml,*/*" } });
        if (!res.ok) throw new Error(`请求失败 ${res.status}: ${rawUrl}`);
        return res.text();
    }

    async function fetchJson(rawUrl, { useProxy = false, signal } = {}) {
        const url = useProxy ? proxiedUrl(rawUrl) : rawUrl;
        const res = await fetch(url, signal ? { signal } : undefined);
        if (!res.ok) throw new Error(`请求失败 ${res.status}: ${rawUrl}`);
        return res.json();
    }

    /* ---------- 解析 RSS XML ---------- */
    // 返回 [{ title, link, description, pubDate }]
    function parseRss(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, "text/xml");
        const items = Array.from(doc.querySelectorAll("item"));
        return items.map(it => ({
            title: text(it, "title"),
            link: text(it, "link"),
            description: text(it, "description"),
            pubDate: text(it, "pubDate")
        })).filter(a => a.title && a.link);
    }

    function text(parent, tag) {
        const el = parent.querySelector(tag);
        return el ? el.textContent.trim() : "";
    }

    /* ---------- 抓取文章并抽取正文段落 ---------- */
    // 思路：用 DOMParser 解析远程 HTML，优先取 <article>/<main> 内容，
    //       过滤掉脚本/样式/导航，提取 <p> 段落。
    async function fetchArticleParagraphs(articleUrl) {
        const html = await fetchText(articleUrl, { useProxy: true });
        const doc = new DOMParser().parseFromString(html, "text/html");

        // 移除无关元素
        doc.querySelectorAll("script, style, nav, header, footer, aside, "
            + "figure, figcaption, .ad, .advert, .related, .share, .newsletter, "
            + "[role='navigation'], [aria-hidden='true']")
            .forEach(el => el.remove());

        // 优先容器
        const container =
            doc.querySelector("article") ||
            doc.querySelector("main") ||
            doc.querySelector('[property="articleBody"]') ||
            doc.querySelector(".article-body, .story-body, .content__article-body, "
                + "#main-content, .post-content, .article__content");

        // 提取段落
        const root = container || doc.body;
        const paras = Array.from(root.querySelectorAll("p"))
            .map(p => p.textContent.replace(/\s+/g, " ").trim())
            .filter(t => t.length >= 40); // 过滤过短的碎片

        return paras.slice(0, 12); // 最多取 12 段，避免过长
    }

    /* ---------- 翻译（LibreTranslate） ---------- */
    async function translateText(text, { source, target } = {}) {
        const src = source || CFG.translateSource;
        const tgt = target || CFG.translateTarget;

        // LibreTranslate POST
        try {
            const res = await fetch(CFG.translateApi, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ q: text, source: src, target: tgt, format: "text" })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.translatedText) return data.translatedText;
            }
        } catch (e) {
            // 降级到备用 API
        }

        // 备用：MyMemory（免费，GET）
        try {
            const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${src}|${tgt}`;
            const data = await fetchJson(url, { useProxy: false });
            if (data && data.responseData && data.responseData.translatedText) {
                return data.responseData.translatedText;
            }
        } catch (e) {
            // 继续
        }

        throw new Error("翻译服务暂不可用");
    }

    /* ---------- 通用工具 ---------- */
    function showToast(msg, type = "") {
        const toast = document.getElementById("toast");
        if (!toast) return;
        toast.textContent = msg;
        toast.className = "toast show " + type;
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.className = "toast hidden";
        }, 2400);
    }

    // 返回 YYYY-MM-DD（本地时区）
    function todayKey() {
        const d = new Date();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${d.getFullYear()}-${m}-${day}`;
    }

    // 返回最近 n 天的日期 key 数组（含今天，降序）
    function recentDays(n) {
        const arr = [];
        const d = new Date();
        for (let i = 0; i < n; i++) {
            const tmp = new Date(d);
            tmp.setDate(d.getDate() - i);
            const m = String(tmp.getMonth() + 1).padStart(2, "0");
            const day = String(tmp.getDate()).padStart(2, "0");
            arr.push(`${tmp.getFullYear()}-${m}-${day}`);
        }
        return arr;
    }

    // 友好日期：08-13 周四
    function friendlyDate(dateStr) {
        const d = new Date(dateStr);
        const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const day = String(d.getDate()).padStart(2, "0");
        return `${m}-${day} ${week}`;
    }

    // localStorage 读写（带 JSON）
    const store = {
        get(key, fallback) {
            try {
                const v = localStorage.getItem(key);
                return v ? JSON.parse(v) : fallback;
            } catch { return fallback; }
        },
        set(key, value) {
            try {
                localStorage.setItem(key, JSON.stringify(value));
                // 通知侧边栏统计等订阅者更新
                document.dispatchEvent(new CustomEvent("dw:dataChanged", { detail: { key, value }, bubbles: true }));
            } catch (e) { /* 配额满 */ }
        },
        remove(key) {
            localStorage.removeItem(key);
            document.dispatchEvent(new CustomEvent("dw:dataChanged", { detail: { key }, bubbles: true }));
        }
    };

    return {
        fetchText, fetchJson, parseRss,
        fetchArticleParagraphs, translateText,
        showToast, todayKey, recentDays, friendlyDate, store
    };
})();
