/* =====================================================================
   app.js — 主应用入口
   ---------------------------------------------------------------------
   - 主题切换（浅色/深色）
   - 左侧导航页面切换（核心）
   - 侧边栏状态实时同步（生词数/待办完成/今日心情）
   - 侧边栏日期
   - 全局刷新按钮
   - 移动端抽屉
   ===================================================================== */

(function () {
    const THEME_KEY = window.APP_CONFIG.storageKeys.theme;
    const PAGE_KEY = "dw_active_page";

    /* =================================================================
       1. 主题
       ================================================================= */
    function applyTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem(THEME_KEY, theme);
    }

    function initTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved) applyTheme(saved);
        else if (window.matchMedia &&
                 window.matchMedia("(prefers-color-scheme: dark)").matches) applyTheme("dark");
        else applyTheme("light");

        document.getElementById("themeToggle").addEventListener("click", () => {
            const cur = document.documentElement.getAttribute("data-theme");
            applyTheme(cur === "dark" ? "light" : "dark");
        });
    }

    /* =================================================================
       2. 导航：页面切换
       ================================================================= */
    const Nav = (() => {
        function init() {
            const items = document.querySelectorAll(".nav-item");
            items.forEach(item => {
                item.addEventListener("click", () => switchTo(item.dataset.page));
            });
            // 从 localStorage 恢复
            const saved = localStorage.getItem(PAGE_KEY);
            if (saved && document.getElementById("page-" + saved)) switchTo(saved, true);
            else switchTo("home", true);
        }

        function switchTo(page, silent) {
            // 更新导航高亮
            document.querySelectorAll(".nav-item").forEach(i => {
                i.classList.toggle("active", i.dataset.page === page);
            });
            // 切换页面
            document.querySelectorAll(".page").forEach(p => {
                p.classList.toggle("active", p.id === "page-" + page);
            });
            if (!silent) localStorage.setItem(PAGE_KEY, page);
            // 关闭移动端抽屉
            document.querySelector(".sidebar")?.classList.remove("open");
            document.getElementById("sidebarBackdrop")?.classList.remove("show");
        }

        return { init, switchTo };
    })();
    // 暴露为全局，供 home.js 等模块调用
    window.Nav = Nav;

    /* =================================================================
       3. 侧边栏统计（实时同步）
       ================================================================= */
    const SidebarStats = (() => {
        function refresh() {
            const CFG = window.APP_CONFIG.storageKeys;

            // 生词量
            const vocab = Api.store.get(CFG.vocabulary, []);
            const vocabEl = document.getElementById("statVocab");
            if (vocabEl) vocabEl.textContent = vocab.length;

            // 待办事项（通用，不再按天）
            const todos = Api.store.get(CFG.todos, []);
            const done = todos.filter(t => t.done).length;
            const doneEl = document.getElementById("statTodoDone");
            const totalEl = document.getElementById("statTodoTotal");
            if (doneEl) doneEl.textContent = done;
            if (totalEl) totalEl.textContent = todos.length;

            // 今日心情
            const moods = Api.store.get(CFG.moods, {});
            const todayMood = moods[Api.todayKey()];
            const moodEl = document.getElementById("statMood");
            if (moodEl) moodEl.textContent = todayMood ? todayMood.mood : "—";
        }

        return { refresh };
    })();

    /* =================================================================
       4. 侧边栏日期
       ================================================================= */
    function renderSidebarDate() {
        const d = new Date();
        const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
        const el = document.getElementById("sidebarDate");
        if (el) el.textContent = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
    }

    /* =================================================================
       5. 移动端抽屉
       ================================================================= */
    function initMobileDrawer() {
        const toggle = document.getElementById("menuToggle");
        const sidebar = document.querySelector(".sidebar");
        const backdrop = document.getElementById("sidebarBackdrop");

        if (!toggle || !sidebar || !backdrop) return;

        toggle.addEventListener("click", () => {
            const isOpen = sidebar.classList.toggle("open");
            backdrop.classList.toggle("show", isOpen);
        });

        backdrop.addEventListener("click", () => {
            sidebar.classList.remove("open");
            backdrop.classList.remove("show");
        });
    }

    /* =================================================================
       6. 全局刷新
       ================================================================= */
    function initRefresh() {
        document.getElementById("refreshAll").addEventListener("click", async () => {
            const btn = document.getElementById("refreshAll");
            btn.disabled = true;
            btn.style.opacity = "0.6";
            Api.showToast("正在刷新…", "");
            try {
                Weather.refresh();
                DailyEnglish.refresh();
                Almanac.refresh();
                News.refresh();
                Todo.refresh();
                Mood.refresh();
                Home.refresh();
                SidebarStats.refresh();
                setTimeout(() => Api.showToast("已刷新 ✨", "success"), 800);
            } finally {
                setTimeout(() => {
                    btn.disabled = false;
                    btn.style.opacity = "";
                }, 1200);
            }
        });
    }

    /* =================================================================
       6b. 全局 [data-goto] 跳转链接
       ================================================================= */
    function initGotoLinks() {
        document.addEventListener("click", e => {
            const link = e.target.closest("[data-goto]");
            if (link) {
                e.preventDefault();
                Nav.switchTo(link.dataset.goto);
            }
        });
    }

    /* =================================================================
       7. 启动
       ================================================================= */
    function boot() {
        initTheme();
        renderSidebarDate();
        initMobileDrawer();
        initRefresh();
        initGotoLinks();
        Nav.init();

        // 各模块初始化（页面切换时只会显示当前激活的那个，但所有模块都已加载）
        Weather.init();
        Vocab.init();
        DailyEnglish.init();
        Almanac.init();
        News.init();
        Todo.init();
        Mood.init();
        Home.init();
        DataIO.init();

        // 同步侧边栏统计
        SidebarStats.refresh();

        // 拦截原始模块的数据变更，自动刷新侧边栏
        // 利用自定义事件实现：各模块在 save 后 dispatch 一个事件
        document.addEventListener("dw:dataChanged", SidebarStats.refresh);

        // 云同步（Supabase）放在最后：先让本地模块渲染，再拉取云端覆盖
        CloudSync.init();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();