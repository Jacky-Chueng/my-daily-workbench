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

    /* ---------- 内容指纹：同一条待办在任何设备上算出的结果都相同 ----------
       旧版本给"没有 id 的历史数据"随机补 id，导致两台电脑对同一条待办
       算出了不同的 id → 云端按 id 合并时对不上 → 删除（墓碑）传不过去。
       改成用「文本 + 创建时间」算出确定性 id，多设备才能对上同一条。 */
    function contentKey(t) {
        return String((t && t.text) || "") + "|" + String((t && t.createdAt) || "");
    }
    function stableId(text, createdAt) {
        const s = String(text || "") + "|" + String(createdAt || "");
        let h = 5381;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return "L" + h.toString(36) + "_" + s.length.toString(36);
    }

    function load() {
        const items = Api.store.get(KEY, []);
        return items.map((it, idx) => {
            if (!it || typeof it !== "object") return it;
            const copy = { ...it };
            if (!copy.id) copy.id = stableId(copy.text, copy.createdAt);
            // 手动排序字段：缺失时按数组顺序兜底（写入后才持久化）
            if (typeof copy.sortOrder !== "number") copy.sortOrder = idx;
            return copy;
        });
    }
    function save(items) { Api.store.set(KEY, items); }

    /* ---------- 自愈：合并"同内容不同 id"的重复项 ----------
       把历史上已经产生的重复条目折叠成一条（墓碑优先，保留删除状态） */
    function dedupe() {
        const items = load();
        const map = new Map();
        let dupes = 0;
        for (const it of items) {
            const k = contentKey(it);
            const prev = map.get(k);
            if (!prev) { map.set(k, it); continue; }
            dupes++;
            map.set(k, mergeTwo(prev, it));
        }
        if (dupes) save(Array.from(map.values()));
        return { removed: dupes, remaining: map.size };
    }

    /* 两条同一内容的待办怎么取舍：墓碑优先（删除不该被旧副本复活），否则取更新的 */
    function mergeTwo(a, b) {
        if (a._deleted && !b._deleted) return a;
        if (b._deleted && !a._deleted) return b;
        const ta = a.updatedAt || a.completedAt || 0;
        const tb = b.updatedAt || b.completedAt || 0;
        return tb > ta ? b : a;
    }

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
        // 未完成的在前，已完成的在后；同组内按手动排序 sortOrder
        items = items.slice().sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            return (a.sortOrder || 0) - (b.sortOrder || 0);
        });
        // 过滤已删除（墓碑 _deleted）的项——删除通过墓碑跨设备同步
        items = items.filter(t => !t._deleted);

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
                <li class="todo-item editing" data-id="${t.id}">
                    <input type="text" class="todo-edit-input" data-id="${t.id}" value="${escapeHtml(t.text)}">
                    <button class="todo-edit-save" data-id="${t.id}" title="保存">✓</button>
                    <button class="todo-edit-cancel" data-id="${t.id}" title="取消">✕</button>
                </li>`;
            }
            return `
                <li class="todo-item ${t.done ? "done" : ""}" data-id="${t.id}">
                    <span class="todo-drag" title="拖动排序">⠿</span>
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
        // 新事项排到「未完成」组的末尾（排除已删除的墓碑项）
        const maxOrder = items
            .filter(i => !i.done && !i._deleted)
            .reduce((m, i) => Math.max(m, i.sortOrder || 0), -1);
        items.push({ id: uid(), text, done: false, createdAt: Date.now(), updatedAt: Date.now(), sortOrder: maxOrder + 1 });
        save(items);
        render();
    }

    function toggle(id) {
        const items = load();
        const it = items.find(x => x.id === id);
        if (!it) return;
        it.done = !it.done;
        it.updatedAt = Date.now();
        if (it.done) it.completedAt = Date.now();
        save(items);
        render();
    }

    function remove(id) {
        const items = load();
        const it = items.find(x => x.id === id);
        if (!it) return;
        // 墓碑式删除：不打断数组，仅标记 _deleted，使其能随同步传到其他设备
        it._deleted = true;
        it._deletedAt = Date.now();
        it.updatedAt = Date.now();   // 让"删除"这个动作有时间戳，合并时不会被旧副本盖掉
        save(items);
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
        if (it) { it.text = val; it.updatedAt = Date.now(); }
        editingId = null;
        save(items);
        render();
        Api.showToast("已更新待办", "success");
    }

    function cancelEdit() {
        editingId = null;
        render();
    }

    /* ---------- 物理清理：永久删除"老"墓碑 ----------
       墓碑是跨设备同步删除用的证据，所以近期删除的先留 3 天，
       确保另一台电脑有机会同步到"删除"，不会被它手里的旧副本复活。 */
    const TOMB_KEEP_MS = 3 * 24 * 60 * 60 * 1000;

    // 注意：必须传入同一份 items 来统计，否则 load() 每次返回新副本、对象引用不同，过滤会失效
    function tombStats(items) {
        const list = items || load();
        const now = Date.now();
        const all = list.filter(t => t._deleted);
        return {
            old: all.filter(t => (now - (t._deletedAt || 0)) > TOMB_KEEP_MS),
            recent: all.filter(t => (now - (t._deletedAt || 0)) <= TOMB_KEEP_MS)
        };
    }

    function purgeDeleted() {
        const items = load();
        const { old, recent } = tombStats(items);
        if (!old.length) {
            return { removed: 0, remaining: items.length, kept: recent.length };
        }
        const oldSet = new Set(old);   // 与 items 同源，引用一致
        const kept = items.filter(t => !oldSet.has(t));
        save(kept);
        render();
        return { removed: old.length, remaining: kept.length, kept: recent.length };
    }

    /* ---------- 拖拽排序（鼠标 + 触屏通用，靠手柄发起）---------- */
    function initDrag() {
        const list = els.list();
        if (!list) return;
        let dragItem = null, active = false, startY = 0, startX = 0;

        function onMove(e) {
            if (!dragItem) return;
            const dx = e.clientX - startX, dy = e.clientY - startY;
            if (!active) {
                if (Math.hypot(dx, dy) < 6) return;   // 移动阈值，避免误触
                active = true;
                dragItem.classList.add("dragging");
            }
            e.preventDefault();
            const y = e.clientY;
            const sibs = Array.from(list.querySelectorAll("li.todo-item:not(.dragging)"));
            let target = null;
            for (const s of sibs) {
                const r = s.getBoundingClientRect();
                if (y < r.top + r.height / 2) { target = s; break; }
            }
            if (target) list.insertBefore(dragItem, target);
            else list.appendChild(dragItem);
        }

        function onUp() {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onUp);
            const item = dragItem;
            dragItem = null;
            const wasActive = active;
            active = false;
            if (item) item.classList.remove("dragging");
            if (!wasActive || !item) return;

            // 按拖拽后的 DOM 顺序，重排同组（未完成/已完成）内的 sortOrder
            const domIds = Array.from(list.querySelectorAll("li.todo-item")).map(li => li.dataset.id);
            const items = load();
            const byId = new Map(items.map(i => [i.id, i]));
            const undoneIds = domIds.filter(id => byId.has(id) && !byId.get(id).done);
            const doneIds = domIds.filter(id => byId.has(id) && byId.get(id).done);
            const rank = new Map();
            undoneIds.forEach((id, i) => rank.set(id, i));
            doneIds.forEach((id, i) => rank.set(id, i));
            items.forEach(it => { if (rank.has(it.id)) it.sortOrder = rank.get(it.id); });
            save(items);
            render();
        }

        list.addEventListener("pointerdown", e => {
            if (e.target.closest(".todo-edit-input")) return;
            const handle = e.target.closest(".todo-drag");
            if (!handle) return;
            const item = handle.closest(".todo-item");
            if (!item || item.classList.contains("editing")) return;
            active = false;
            dragItem = item;
            startY = e.clientY;
            startX = e.clientX;
            document.addEventListener("pointermove", onMove);
            document.addEventListener("pointerup", onUp);
            document.addEventListener("pointercancel", onUp);
        });
    }

    /* ---------- 初始化 ---------- */
    function init() {
        migrateLegacy(); // 先迁移旧数据
        // 自愈：折叠历史遗留的"同内容不同 id"重复项，让多端能对上同一条
        const d = dedupe();
        if (d.removed) console.log(`[待办去重] 合并了 ${d.removed} 条重复项，剩余 ${d.remaining} 条`);
        const form = els.form();
        if (form) {
            form.addEventListener("submit", e => {
                e.preventDefault();
                add(els.input().value);
                els.input().value = "";
                Api.showToast("已添加待办", "success");
            });
        }
        // 清理墓碑按钮：把已删除项从 localStorage 和云端一起抹掉
        const purgeBtn = document.getElementById("todoPurgeBtn");
        if (purgeBtn) {
            purgeBtn.addEventListener("click", () => {
                const { old, recent } = tombStats();
                if (!old.length) {
                    Api.showToast(recent.length
                        ? `暂无可清理项：${recent.length} 条是 3 天内删除的，需保留以确保其他设备同步到删除`
                        : "没有可清理的已删除项", "");
                    return;
                }
                if (!confirm(
                    `将永久清理 ${old.length} 条「3 天前删除」的待办，云端也会同步清理。\n\n`
                    + `另有 ${recent.length} 条是近期删除的，先保留 3 天，确保另一台电脑能同步到删除。`
                )) return;
                const r = purgeDeleted();
                // 立刻把清理后的本地数据推到云端，避免被残留的云端墓碑"复活"
                if (window.CloudSync && CloudSync.flushNow) CloudSync.flushNow();
                Api.showToast(`已清理 ${r.removed} 条，剩余 ${r.remaining} 条`, "success");
            });
        }
        // 云端同步完成后（其他设备改了数据）重新渲染本页
        document.addEventListener("dw:remoteSynced", () => {
            if (!editingId) render();   // 正在行内编辑时不打断
        });
        initDrag();
        render();
    }

    function refresh() { render(); }

    return { init, refresh, add, load, save, purgeDeleted, dedupe, contentKey, mergeTwo };
})();
