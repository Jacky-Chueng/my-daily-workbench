/* =====================================================================
   daily-english.js — 每日英语模块（核心）
   ---------------------------------------------------------------------
   功能：
   1. 从 RSS 获取最新文章列表（默认 The Guardian，可切换 BBC/Reuters）
   2. 优先用 RSS 摘要（description）抽取段落，过短才抓取全文（提速关键）
   3. 英文原文 + 中文翻译对照展示
   4. 每段"一键翻译"按钮 + "翻译全文"按钮
   5. "换一篇"切换下一篇 RSS 文章
   6. 翻译结果 + 文章列表本地缓存（当天 6 小时，避免重复外网请求）
   7. 智能多段拼接：单篇过短时自动追加后续文章，保证大篇幅阅读量
   ===================================================================== */

const DailyEnglish = (() => {
    const CFG = window.APP_CONFIG;
    const SOURCE_KEY = "dw_current_source";

    let currentSource = localStorage.getItem(SOURCE_KEY) || "guardian";
    let articleList = [];      // 当前源抓到的文章列表
    let articleIndex = 0;      // 当前展示第几篇
    // 翻译缓存：{ 段落文本hash -> 中文 }
    const transCache = {};

    /* ---------- 阅读量配置 ---------- */
    const MIN_PARAS = 5;           // 最少段数（不足则追加下一篇）
    const MIN_CHARS = 800;         // 最少字符数（不足则追加）
    const MAX_ARTICLES = 3;        // 最多拼接几篇文章（避免无限加载）

    /* ---------- DOM ---------- */
    const els = {
        meta: () => document.getElementById("englishMeta"),
        body: () => document.getElementById("articleBody"),
        footer: () => document.getElementById("articleFooter"),
        source: () => document.getElementById("articleSource"),
        next: () => document.getElementById("nextArticle"),
        translateAll: () => document.getElementById("translateAll")
    };

    /* ---------- 简单字符串哈希（用于缓存键） ---------- */
    function hash(s) {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return "t" + Math.abs(h);
    }

    /* ---------- 获取文章列表 ---------- */
    async function fetchArticleList(sourceKey) {
        const src = CFG.rssSources[sourceKey];
        if (!src) throw new Error("未知文章来源");

        // 依次尝试每个 feed，成功即返回
        for (const feed of src.feeds) {
            try {
                const xml = await Api.fetchText(feed, { useProxy: true });
                const list = Api.parseRss(xml);
                if (list && list.length) {
                    return list.map(a => ({ ...a, source: src.name }));
                }
            } catch (e) {
                console.warn("RSS 获取失败:", feed, e);
            }
        }
        throw new Error(`无法获取 ${src.name} 的 RSS`);
    }

    /* ---------- 本地缓存（当天 + 6 小时） ---------- */
    // 缓存结构：{ source, ts, articles:[{title,link,pubDate,source,paras:[...]}] }
    const CACHE_KEY = "dw_english_cache";
    const CACHE_TTL = 6 * 60 * 60 * 1000;

    function getCache(sourceKey) {
        const c = Api.store.get(CACHE_KEY, null);
        if (!c || c.source !== sourceKey) return null;
        if (Date.now() - c.ts > CACHE_TTL) return null;
        return c.articles;
    }
    function setCache(sourceKey, articles) {
        Api.store.set(CACHE_KEY, { source: sourceKey, ts: Date.now(), articles });
    }

    // 从 RSS description（HTML 片段）提取纯文本段落；无 <p> 则取整体文本
    function extractParas(htmlOrText) {
        if (!htmlOrText) return [];
        const doc = new DOMParser().parseFromString(htmlOrText, "text/html");
        const ps = Array.from(doc.querySelectorAll("p"))
            .map(p => p.textContent.replace(/\s+/g, " ").trim())
            .filter(t => t.length >= 30);
        if (ps.length) return ps;
        const whole = doc.body.textContent.replace(/\s+/g, " ").trim();
        return whole.length >= 30 ? [whole] : [];
    }

    // 确保 articleList 就绪：优先读缓存（秒开），否则抓 RSS 并预提取段落（首屏只抓一次）
    async function ensureArticles() {
        if (articleList.length) return;
        const cached = getCache(currentSource);
        if (cached && cached.length) {
            articleList = cached;
            articleIndex = 0;
            return;
        }
        const list = await fetchArticleList(currentSource);
        articleList = list.map(a => ({
            title: a.title, link: a.link, pubDate: a.pubDate, source: a.source,
            paras: extractParas(a.description || a.title)
        }));
        setCache(currentSource, articleList);
        articleIndex = 0;
    }

    /* ---------- 确保单篇文章有足够内容（尝试抓全文补齐） ---------- */
    async function enrichArticle(article) {
        let paras = article.paras || [];

        // description 提取的内容太少 → 尝试抓全文
        if (paras.join(" ").replace(/\s/g, "").length < 120 || paras.length < 2) {
            try {
                const full = await Api.fetchArticleParagraphs(article.link);
                if (full.length >= paras.length) {
                    paras = full;
                    article.paras = full;
                }
            } catch (e) {
                console.warn("正文抓取失败:", article.title, e);
            }
        }

        if (!paras.length) paras = [article.title];
        article.paras = paras;
        return paras;
    }

    /* ---------- 加载并展示文章（智能多段拼接） ---------- */
    async function loadArticle() {
        const meta = els.meta();
        const body = els.body();
        const footer = els.footer();

        meta.innerHTML = '<span class="loading-text">正在获取今日文章…</span>';
        body.innerHTML = '<p class="loading-text">文章加载中，请稍候…</p>';
        footer.innerHTML = "";

        try {
            await ensureArticles();

            // 收集足够多的段落：从当前文章开始，不足则追加后续篇
            const allParas = [];       // 所有段落文本
            const allArticles = [];    // 涉及的文章（用于显示来源）
            let idx = articleIndex;
            let attempts = 0;

            while (attempts < MAX_ARTICLES && idx < articleList.length) {
                const art = articleList[idx];
                const paras = await enrichArticle(art);
                allParas.push(...paras);
                allArticles.push(art);
                attempts++;

                // 够长了就停
                const totalText = allParas.join(" ").replace(/\s/g, "");
                if (allParas.length >= MIN_PARAS && totalText.length >= MIN_CHARS) break;

                idx++;
            }

            // 如果循环完还是太短（比如列表就几篇短文），至少保证有内容
            if (!allParas.length) throw new Error("没有可用文章");

            // 记录拼接篇数，供"换一篇"跳过用
            lastArticleCount = Math.max(allArticles.length, 1);

            const primaryArticle = allArticles[0];

            // 展示标题与元信息（多篇时用主文章标题 + 篇数提示）
            const multiLabel = allArticles.length > 1
                ? ` <span style="font-size:12px;color:var(--text-faint);font-weight:400;">（已拼接 ${allArticles.length} 篇）</span>`
                : "";
            meta.innerHTML = `
                <span class="meta-title">${escapeHtml(primaryArticle.title)}${multiLabel}</span>
                ${primaryArticle.pubDate ? `<span>📅 ${new Date(primaryArticle.pubDate).toLocaleDateString()}</span>` : ""}
                <span>📰 ${escapeHtml(primaryArticle.source)}</span>
                <a class="meta-link" href="${primaryArticle.link}" target="_blank" rel="noopener">查看原文 ↗</a>
            `;

            renderParagraphs(allParas, allArticles);

        } catch (e) {
            console.error("每日英语加载失败:", e);
            renderFallback();
        }
    }

    /* ---------- 渲染段落（英文原文 + 待翻译占位） ---------- */
    function renderParagraphs(paras, articles) {
        const body = els.body();
        const isMulti = Array.isArray(articles) && articles.length > 1;

        // 构建每篇文章的段落范围，用于插入分隔线
        const articleBounds = []; // { startIdx, endIdx, article }
        if (isMulti) {
            let pIdx = 0;
            for (const art of articles) {
                const count = (art.paras || []).length;
                if (count > 0) {
                    articleBounds.push({ startIdx: pIdx, endIdx: pIdx + count - 1, article: art });
                    pIdx += count;
                }
            }
        }

        let html = "";
        paras.forEach((p, i) => {
            // 在第二篇及之后的文章前插入分隔线
            if (isMulti) {
                const bound = articleBounds.find(b => b.startIdx === i);
                if (bound && bound.startIdx > 0) {
                    html += `<div class="article-divider">
                        <span class="divider-line"></span>
                        <span class="divider-label">📄 ${escapeHtml(bound.article.title)}</span>
                        <span class="divider-line"></span>
                    </div>`;
                }
            }

            html += `
            <div class="para-block" data-idx="${i}">
                <p class="para-en">${escapeHtml(p)}</p>
                <div class="para-zh hidden" data-trans="${i}"></div>
                <div class="para-actions">
                    <button class="btn btn-ghost btn-sm translate-one" data-idx="${i}">一键翻译</button>
                </div>
            </div>`;
        });

        body.innerHTML = html;

        // 绑定单段翻译
        body.querySelectorAll(".translate-one").forEach(btn => {
            btn.addEventListener("click", () => translateOne(Number(btn.dataset.idx)));
        });

        // 来源信息
        const primary = Array.isArray(articles) ? articles[0] : articles;
        const countLabel = isMulti ? `${articles.length} 篇拼接` : "1 篇";
        els.footer().innerHTML = `
            来源：<a href="${primary.link}" target="_blank" rel="noopener">${escapeHtml(primary.source)}</a>
            · ${countLabel} · 共 ${paras.length} 段 · 选中任意单词可加入生词库
        `;
    }

    /* ---------- 翻译单段 ---------- */
    async function translateOne(idx) {
        const block = els.body().querySelector(`.para-block[data-idx="${idx}"]`);
        if (!block) return;
        const enText = block.querySelector(".para-en").textContent;
        const zhBox = block.querySelector(".para-zh");
        const btn = block.querySelector(".translate-one");

        // 命中缓存
        const h = hash(enText);
        if (transCache[h]) {
            zhBox.textContent = transCache[h];
            zhBox.classList.remove("hidden", "loading");
            btn.textContent = "已翻译 ✓";
            btn.disabled = true;
            return;
        }

        zhBox.textContent = "翻译中…";
        zhBox.classList.remove("hidden");
        zhBox.classList.add("loading");
        btn.disabled = true;
        btn.textContent = "翻译中…";

        try {
            const zh = await Api.translateText(enText);
            transCache[h] = zh;
            zhBox.textContent = zh;
            zhBox.classList.remove("loading");
            btn.textContent = "已翻译 ✓";
        } catch (e) {
            zhBox.textContent = "翻译失败，请稍后重试";
            btn.disabled = false;
            btn.textContent = "重试翻译";
        }
    }

    /* ---------- 翻译全文 ---------- */
    async function translateAll() {
        const blocks = els.body().querySelectorAll(".para-block");
        const btn = els.translateAll();
        btn.disabled = true;
        btn.textContent = "翻译中…";

        // 串行翻译，避免触发速率限制
        for (let i = 0; i < blocks.length; i++) {
            await translateOne(i);
        }
        btn.disabled = false;
        btn.textContent = "翻译全文";
        Api.showToast("全文翻译完成", "success");
    }

    /* ---------- 换一篇（跳过本次已展示的文章） ---------- */
    let lastArticleCount = 1; // 上次展示了几篇（用于跳过）

    async function nextArticle() {
        if (!articleList.length) {
            await loadArticle();
            return;
        }
        // 跳过上次拼接过的文章数，避免重复
        articleIndex = (articleIndex + lastArticleCount) % articleList.length;
        if (articleIndex === 0) lastArticleCount = 0; // 循环回头时不额外跳
        await loadArticle();
    }

    /* ---------- 切换来源 ---------- */
    async function switchSource(sourceKey) {
        currentSource = sourceKey;
        localStorage.setItem(SOURCE_KEY, sourceKey);
        articleList = [];
        articleIndex = 0;
        await loadArticle();
    }

    /* ---------- 兜底示例文章（所有外网请求失败时） ---------- */
    function renderFallback() {
        const sample = [
            {
                title: "Scientists Discover New Species in Deep Ocean Expedition",
                source: "示例数据",
                link: "#",
                pubDate: new Date().toISOString(),
                paragraphs: [
                    "A team of marine biologists has announced the discovery of several previously unknown species during a deep-sea expedition in the Pacific Ocean. The findings, published this week, could reshape our understanding of biodiversity in one of Earth's most remote environments.",
                    "The expedition, which lasted six weeks, used advanced submersibles to explore depths exceeding 4,000 meters. Researchers collected samples of organisms ranging from bioluminescent jellyfish to crustaceans with remarkable adaptations to extreme pressure.",
                    "Lead researcher Dr. Elena Martinez described the discovery as 'a reminder of how much remains unknown about our oceans.' She emphasized that protecting these fragile ecosystems is crucial as climate change and deep-sea mining pose growing threats.",
                    "The team plans to conduct further genetic analysis to determine how these new species relate to known marine life. The results will contribute to ongoing efforts to map the ocean's biodiversity and inform conservation policies worldwide."
                ]
            }
        ];
        articleList = sample;
        articleIndex = 0;
        const article = sample[0];

        els.meta().innerHTML = `
            <span class="meta-title">${escapeHtml(article.title)}</span>
            <span>📰 示例数据（外网请求失败时的兜底内容）</span>
        `;
        renderParagraphs(article.paragraphs, article);
    }

    /* ---------- 初始化 ---------- */
    function init() {
        // 同步下拉框选中状态
        if (els.source()) els.source().value = currentSource;

        els.source().addEventListener("change", e => switchSource(e.target.value));
        els.next().addEventListener("click", nextArticle);
        els.translateAll().addEventListener("click", translateAll);

        loadArticle();
    }

    function refresh() { loadArticle(); }

    return { init, refresh, nextArticle };
})();
