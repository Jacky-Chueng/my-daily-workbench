/* =====================================================================
   home-layout.js — 首页布局自定义模块
   ---------------------------------------------------------------------
   功能：
   1. 记忆首页 4 张卡片（天气/黄历/待办/生词）的排列顺序与显隐状态
   2. 「自定义布局」编辑模式：拖拽排序（HTML5 drag & drop）+ 显隐开关
   3. 布局存 localStorage，并通过 dw:dataChanged 触发 Supabase 云同步
   4. 监听 dw:remoteSynced，云端布局变化时自动重新应用
   ===================================================================== */

const HomeLayout = (() => {
    const SK = window.APP_CONFIG.storageKeys;
    const KEY = SK.homeLayout;
    // 4 张卡片的稳定标识（与 index.html 的 id 对应）
    const DEFAULT_ORDER = ["card-weather", "almanacCard", "card-home-todo", "card-home-vocab"];

    let editing = false;
    let layout = { order: DEFAULT_ORDER.slice(), hidden: [] };

    function getGrid() { return document.getElementById("homeGrid"); }

    /* ---------- 加载布局（兼容新增卡片） ---------- */
    function load() {
        const saved = Api.store.get(KEY, null);
        if (saved && Array.isArray(saved.order)) {
            // 保留已存顺序中仍存在的卡片，并把新卡片补到末尾
            const merged = saved.order.filter(id => DEFAULT_ORDER.includes(id));
            DEFAULT_ORDER.forEach(id => { if (!merged.includes(id)) merged.push(id); });
            const hidden = Array.isArray(saved.hidden)
                ? saved.hidden.filter(id => DEFAULT_ORDER.includes(id))
                : [];
            layout = { order: merged, hidden };
        } else {
            layout = { order: DEFAULT_ORDER.slice(), hidden: [] };
        }
        return layout;
    }

    /* ---------- 持久化（触发云同步） ---------- */
    function save() {
        // Api.store.set 会 dispatch dw:dataChanged，CloudSync 据此上传
        Api.store.set(KEY, layout);
    }

    /* ---------- 应用布局：重排 DOM + 隐藏指定卡片 ---------- */
    function applyLayout() {
        const grid = getGrid();
        if (!grid) return;

        // 按 order 重排 DOM（依次 append 到末尾，最终顺序即 order）
        layout.order.forEach(id => {
            const card = document.getElementById(id);
            if (card && card.parentNode === grid) grid.appendChild(card);
        });

        // 应用显隐
        layout.order.forEach(id => {
            const card = document.getElementById(id);
            if (!card) return;
            const isHidden = layout.hidden.includes(id);
            // 编辑模式下强制显示（由 .editing CSS 保证），非编辑模式才隐藏
            if (!editing) card.style.display = isHidden ? "none" : "";
            card.classList.toggle("is-hidden", isHidden && editing);
        });
    }

    /* ---------- 注入顶部工具栏 ---------- */
    function injectToolbar() {
        const grid = getGrid();
        if (!grid || document.getElementById("homeToolbar")) return;
        const bar = document.createElement("div");
        bar.className = "home-toolbar";
        bar.id = "homeToolbar";
        bar.innerHTML = `
            <button id="editLayoutBtn" class="btn btn-ghost btn-sm" type="button">⚙ 自定义布局</button>
            <span class="home-toolbar-hint" id="layoutHint">拖拽卡片排序 · 点「隐藏」收起某张卡片 · 完成后点「完成」</span>
        `;
        grid.parentNode.insertBefore(bar, grid);
    }

    /* ---------- 显隐开关按钮 ---------- */
    function ensureHideButtons() {
        layout.order.forEach(id => {
            const card = document.getElementById(id);
            if (!card) return;
            const head = card.querySelector(".card-head");
            if (!head || head.querySelector(".layout-hide-btn")) return;
            const btn = document.createElement("button");
            btn.className = "layout-hide-btn";
            btn.type = "button";
            btn.textContent = layout.hidden.includes(id) ? "显示" : "隐藏";
            btn.addEventListener("click", e => {
                e.stopPropagation();
                toggleHidden(id);
            });
            head.appendChild(btn);
        });
    }

    function toggleHidden(id) {
        const i = layout.hidden.indexOf(id);
        if (i >= 0) layout.hidden.splice(i, 1);
        else layout.hidden.push(id);
        save();

        const card = document.getElementById(id);
        const btn = card && card.querySelector(".layout-hide-btn");
        const isHidden = layout.hidden.includes(id);
        if (btn) btn.textContent = isHidden ? "显示" : "隐藏";
        if (card) card.classList.toggle("is-hidden", isHidden);
    }

    /* ---------- 拖拽排序（编辑模式） ---------- */
    function enableDrag() {
        const grid = getGrid();
        grid.querySelectorAll(".card").forEach(card => {
            card.draggable = true;
            card.addEventListener("dragstart", onDragStart);
            card.addEventListener("dragend", onDragEnd);
        });
        grid.addEventListener("dragover", onDragOver);
    }

    function onDragStart(e) {
        e.currentTarget.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
    }

    function onDragEnd(e) {
        const card = e.currentTarget;
        card.classList.remove("dragging");
        // 保存新顺序
        const grid = getGrid();
        const ids = Array.from(grid.querySelectorAll(".card")).map(c => c.id).filter(Boolean);
        layout.order = ids;
        save();
    }

    function onDragOver(e) {
        e.preventDefault();
        const grid = getGrid();
        const dragging = grid.querySelector(".dragging");
        if (!dragging) return;
        const after = getDragAfterElement(grid, e.clientY);
        if (after == null) grid.appendChild(dragging);
        else grid.insertBefore(dragging, after);
    }

    // 经典一维排序算法（编辑模式为单列，按 clientY 即可）
    function getDragAfterElement(container, y) {
        const cards = Array.from(container.querySelectorAll(".card:not(.dragging)"));
        let closest = { offset: -Infinity, el: null };
        for (const child of cards) {
            const box = child.getBoundingClientRect();
            const offset = y - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) {
                closest = { offset, el: child };
            }
        }
        return closest.el;
    }

    /* ---------- 进入 / 退出编辑模式 ---------- */
    function enterEdit() {
        editing = true;
        const grid = getGrid();
        grid.classList.add("editing");
        // 编辑模式下显示所有卡片（含已隐藏的，便于重新开启）
        grid.querySelectorAll(".card").forEach(c => { c.style.display = ""; });
        layout.hidden.forEach(id => document.getElementById(id)?.classList.add("is-hidden"));
        ensureHideButtons();
        enableDrag();

        const btn = document.getElementById("editLayoutBtn");
        if (btn) { btn.textContent = "✓ 完成"; btn.classList.add("active"); }
        const hint = document.getElementById("layoutHint");
        if (hint) hint.style.display = "";
    }

    function exitEdit() {
        editing = false;
        const grid = getGrid();
        grid.classList.remove("editing");
        grid.querySelectorAll(".card").forEach(c => {
            c.draggable = false;
            c.classList.remove("is-hidden");
            const b = c.querySelector(".layout-hide-btn");
            if (b) b.remove();
        });
        grid.removeEventListener("dragover", onDragOver);
        applyLayout(); // 恢复显隐

        const btn = document.getElementById("editLayoutBtn");
        if (btn) { btn.textContent = "⚙ 自定义布局"; btn.classList.remove("active"); }
        const hint = document.getElementById("layoutHint");
        if (hint) hint.style.display = "none";
    }

    function toggleEdit() {
        if (editing) exitEdit(); else enterEdit();
    }

    /* ---------- 初始化 ---------- */
    function init() {
        load();
        applyLayout();
        injectToolbar();

        const btn = document.getElementById("editLayoutBtn");
        if (btn) btn.addEventListener("click", toggleEdit);

        // 云端布局变化时重新应用（仅非编辑态，避免打断正在拖拽）
        document.addEventListener("dw:remoteSynced", () => {
            load();
            if (!editing) applyLayout();
        });
    }

    return { init, applyLayout };
})();
