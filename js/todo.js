/* =====================================================================
   todo.js — 待办事项模块（通用，不再限于今日）
   ---------------------------------------------------------------------
   - 所有待办统一存储在 dw_todos，不再按天分隔
   - 支持添加、删除、标记完成、以及行内编辑已有待办
   - 每条待办有稳定 id，避免排序后索引错位
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

    let editingId = null;

    function uid() {
        return "t_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
    }

    function load() {
        let items = Api.store.get(KEY, []);
        let changed = false;
        items = items.map(it => {
            if (!it || typeof it !== "object") return it;
            if (!it.id) { it.id = uid(); changed = true; }
            return it;
        });
        if (changed) save(items);
        return items;
    }
    function save(items) { Api.store.set(KEY, items); }

    /* ---------- 迁移旧版按天存储数据（补齐 id）---------- */
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
                if (!item.id) item.id = uid();
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
        items = items.slice().sort((a, b) => {
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

        list.innerHTML = items.map(t => {
            if (t.id === editingId) {
                return `
                <li class="todo-item editing">
                    <input type="text" class="todo-edit-input" data-id="${t.id}" value="${escapeHtml(t.text)}">
                    <button class="todo-edit-save" data-id="${t.id}" title="保存">✓</button>
                    <button class="todo-edit-cancel" data-id="${t.id}" title="取消">✕</button>
                </li>`;
            }
            return `
                <li class="todo-item ${t.done ? "done" : ""}">
                    <input type="checkbox" class="todo-check" data-id="${t.id}" ${t.done ? "checked" : ""}>
                    <span class="todo-text">${escapeHtml(t.text)}</span>
                    <button class="todo-edit" data-id="${t.id}" title="编辑">✎</button>
                    <button class="todo-del" data-id="${t.id}" title="删除">✕</button>
                </li>`;
        }).join("");

        list.querySelectorAll(".todo-check").forEach(cb => {
            cb.addEventListener("change", () => toggle(cb.dataset.id));
        });
        list.querySelectorAll(".todo-del").forEach(btn => {
            btn.addEventListener("click", () => remove(btn.dataset.id));
        });
        list.querySelectorAll(".todo-edit").forEach(btn => {
            btn.addEventListener("click", () => startEdit(btn.dataset.id));
        });
        list.querySelectorAll(".todo-edit-save").forEach(btn => {
            btn.addEventListener("click", () => commitEdit(btn.dataset.id));
        });
        list.querySelectorAll(".todo-edit-cancel").forEach(btn => {
            btn.addEventListener("click", cancelEdit);
        });

        const inp = list.querySelector(".todo-edit-input");
        if (inp) {
            inp.focus();
            inp.select();
            inp.addEventListener("keydown", e => {
                if (e.key === "Enter") commitEdit(inp.dataset.id);
                else if (e.key === "Escape") cancelEdit();
            });
        }
    }

    /* ---------- 操作 ---------- */
    function add(text) {
        text = text.trim();
        if (!text) return;
        const items = load();
        items.push({ id: uid(), text, done: false, createdAt: Date.now() });
        save(items);
        render();
    }

    function toggle(id) {
        const items = load();
        const it = items.find(x => x.id === id);
        if (!it) return;
        it.done = !it.done;
        if (it.done) it.completedAt = Date.now();
        save(items);
        render();
    }

    function remove(id) {
        const items = load();
        const next = items.filter(x => x.id !== id);
        save(next);
        render();
    }

    function startEdit(id) {
        editingId = id;
        render();
    }

    function commitEdit(id) {
        const inp = els.list().querySelector(`.todo-edit-input[data-id="${id}"]`);
        const val = inp ? inp.value.trim() : "";
        if (!val) {
            Api.showToast("内容不能为空", "error");
            return;
        }
        const items = load();
        const it = items.find(x => x.id === id);
        if (it) it.text = val;
        editingId = null;
        save(items);
        render();
        Api.showToast("已更新待办", "success");
    }

    function cancelEdit() {
        editingId = null;
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
