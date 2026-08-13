/* =====================================================================
   todo.js — 待办事项模块（通用，不再限于今日）
   ---------------------------------------------------------------------
   - 所有待办统一存储在 dw_todos，不再按天分隔
   - 支持添加、删除、标记完成
   - 已完成的排在后面，未完成的在前
   - 自动迁移旧版按天存储的数据
   ===================================================================== */

const Todo = (() => {
    const KEY = window.APP_CONFIG.storageKeys.todos;
    const LEGACY_PREFIX = window.APP_CONFIG.storageKeys.todosLegacy || "dw_todos_";

    const els = {
        form: () => document.getElementById("todoForm"),
        input: () => document.getElementById("todoInput"),
        list: () => document.getElementById("todoList"),
        count: () => document.getElementById("todoCount")
    };

    function load() { return Api.store.get(KEY, []); }
    function save(items) { Api.store.set(KEY, items); }

    /* ---------- 迁移旧版按天存储数据 ---------- */
    function migrateLegacy() {
        const all = [];
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(LEGACY_PREFIX)) {
                const items = Api.store.get(key, []);
                all.push(...items);
                keysToRemove.push(key);
            }
        }
        if (all.length) {
            const existing = load();
            const merged = [...existing];
            for (const item of all) {
                if (!merged.some(m => m.text === item.text && m.createdAt === item.createdAt)) {
                    merged.push(item);
                }
            }
            save(merged);
            keysToRemove.forEach(k => localStorage.removeItem(k));
            console.log(`[迁移] 合并了 ${all.length} 条旧版按天待办数据`);
        }
    }

    /* ---------- 渲染 ---------- */
    function render() {
        let items = load();
        // 未完成的在前，已完成的在后
        items = items.sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            return (b.createdAt || 0) - (a.createdAt || 0);
        });

        const list = els.list();
        const count = els.count();
        const pending = items.filter(t => !t.done).length;
        if (count) count.textContent = pending;

        if (!list) return;

        if (!items.length) {
            list.innerHTML = '<li class="empty-hint">还没有待办，添加一条开始吧～</li>';
            return;
        }

        list.innerHTML = items.map((t, i) => `
            <li class="todo-item ${t.done ? "done" : ""}">
                <input type="checkbox" class="todo-check" data-idx="${i}" ${t.done ? "checked" : ""}>
                <span class="todo-text">${escapeHtml(t.text)}</span>
                <button class="todo-del" data-idx="${i}" title="删除">✕</button>
            </li>
        `).join("");

        list.querySelectorAll(".todo-check").forEach(cb => {
            cb.addEventListener("change", () => toggle(Number(cb.dataset.idx)));
        });
        list.querySelectorAll(".todo-del").forEach(btn => {
            btn.addEventListener("click", () => remove(Number(btn.dataset.idx)));
        });
    }

    /* ---------- 操作 ---------- */
    function add(text) {
        text = text.trim();
        if (!text) return;
        const items = load();
        items.push({ text, done: false, createdAt: Date.now() });
        save(items);
        render();
    }

    function toggle(idx) {
        const items = load();
        if (idx < 0 || idx >= items.length) return;
        items[idx].done = !items[idx].done;
        if (items[idx].done) items[idx].completedAt = Date.now();
        save(items);
        render();
    }

    function remove(idx) {
        const items = load();
        if (idx < 0 || idx >= items.length) return;
        items.splice(idx, 1);
        save(items);
        render();
    }

    /* ---------- 初始化 ---------- */
    function init() {
        migrateLegacy(); // 先迁移旧数据
        const form = els.form();
        if (form) {
            form.addEventListener("submit", e => {
                e.preventDefault();
                add(els.input().value);
                els.input().value = "";
                Api.showToast("已添加待办", "success");
            });
        }
        render();
    }

    function refresh() { render(); }

    return { init, refresh, add, load, save };
})();
