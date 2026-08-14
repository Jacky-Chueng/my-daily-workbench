/* =====================================================================
   home.js — 首页模块（待办清单 + 生词复习）
   ---------------------------------------------------------------------
   - 首页待办：复用 Todo 数据，独立渲染（最多显示 6 条，可添加/勾选/删除）
   - 生词复习：从生词库随机取 5 个词，点击翻面看释义
   - 监听 dw:dataChanged 事件，数据变更时自动刷新
   ===================================================================== */

const Home = (() => {
    const SK = window.APP_CONFIG.storageKeys;

    const els = {
        todoForm: () => document.getElementById("homeTodoForm"),
        todoInput: () => document.getElementById("homeTodoInput"),
        todoList: () => document.getElementById("homeTodoList"),
        todoCount: () => document.getElementById("homeTodoCount"),
        vocabReview: () => document.getElementById("vocabReview"),
        refreshVocab: () => document.getElementById("refreshVocabCard")
    };

    /* ---------- 排序：未完成在前，同组按手动顺序 ---------- */
    function sortedTodos() {
        return Todo.load().sort((a, b) => {
            if (a.done !== b.done) return a.done ? 1 : -1;
            return (a.sortOrder || 0) - (b.sortOrder || 0);
        });
    }

    /* ---------- 渲染待办 ---------- */
    function renderTodo() {
        const list = els.todoList();
        const count = els.todoCount();
        if (!list) return;

        const items = sortedTodos();
        const pending = items.filter(t => !t.done).length;
        if (count) count.textContent = pending;

        if (!items.length) {
            list.innerHTML = '<li class="empty-hint">还没有待办，添加一条开始吧～</li>';
            return;
        }

        const display = items.slice(0, 6);
        list.innerHTML = display.map(t => `
            <li class="todo-item ${t.done ? "done" : ""}">
                <input type="checkbox" class="todo-check" data-id="${t.id}" ${t.done ? "checked" : ""}>
                <span class="todo-text">${escapeHtml(t.text)}</span>
                <button class="todo-del" data-id="${t.id}" title="删除">✕</button>
            </li>
        `).join("");

        if (items.length > 6) {
            list.innerHTML += `<li class="todo-more">还有 ${items.length - 6} 条待办，<a href="#" data-goto="todo">查看全部 →</a></li>`;
        }

        list.querySelectorAll(".todo-check").forEach(cb => {
            cb.addEventListener("change", () => toggleTodo(cb.dataset.id));
        });
        list.querySelectorAll(".todo-del").forEach(btn => {
            btn.addEventListener("click", () => removeTodo(btn.dataset.id));
        });

        // "查看全部" 跳转
        const gotoLink = list.querySelector('[data-goto="todo"]');
        if (gotoLink) {
            gotoLink.addEventListener("click", e => {
                e.preventDefault();
                if (window.Nav) Nav.switchTo("todo");
            });
        }
    }

    /* ---------- 待办操作（通过 createdAt 定位） ---------- */
    function addTodo(text) {
        text = text.trim();
        if (!text) return;
        Todo.add(text);          // 复用主模块：自动分配 id / sortOrder
        renderTodo();
        Api.showToast("已添加待办", "success");
    }

    function toggleTodo(id) {
        const items = Todo.load();
        const item = items.find(t => t.id === id);
        if (item) {
            item.done = !item.done;
            if (item.done) item.completedAt = Date.now();
            Todo.save(items);
            renderTodo();
            Todo.refresh();
        }
    }

    function removeTodo(id) {
        const items = Todo.load();
        const idx = items.findIndex(t => t.id === id);
        if (idx >= 0) {
            items.splice(idx, 1);
            Todo.save(items);
            renderTodo();
            Todo.refresh();
        }
    }

    /* ---------- 渲染生词复习（随机 5 个） ---------- */
    function renderVocab() {
        const container = els.vocabReview();
        if (!container) return;

        const vocab = Api.store.get(SK.vocabulary, []);
        if (!vocab.length) {
            container.innerHTML = '<p class="empty-hint">生词库还是空的，去每日英语选词添加吧～</p>';
            return;
        }

        // 随机取 5 个（不足 5 个则全部）
        const shuffled = [...vocab].sort(() => Math.random() - 0.5);
        const picked = shuffled.slice(0, Math.min(5, shuffled.length));

        container.innerHTML = picked.map(w => `
            <div class="vocab-card-flip" data-word="${escapeHtml(w.word)}">
                <div class="vcf-front">
                    <span class="vcf-word">${escapeHtml(w.word)}</span>
                    <span class="vcf-hint">点击查看释义</span>
                </div>
                <div class="vcf-back hidden">
                    <span class="vcf-meaning">${escapeHtml(w.meaning || "（无释义）")}</span>
                    <span class="vcf-hint">点击返回单词</span>
                </div>
            </div>
        `).join("");

        // 点击翻面
        container.querySelectorAll(".vocab-card-flip").forEach(card => {
            card.addEventListener("click", () => {
                card.querySelector(".vcf-front").classList.toggle("hidden");
                card.querySelector(".vcf-back").classList.toggle("hidden");
            });
        });
    }

    /* ---------- 初始化 ---------- */
    function init() {
        const form = els.todoForm();
        if (form) {
            form.addEventListener("submit", e => {
                e.preventDefault();
                addTodo(els.todoInput().value);
                els.todoInput().value = "";
            });
        }

        const refreshBtn = els.refreshVocab();
        if (refreshBtn) {
            refreshBtn.addEventListener("click", renderVocab);
        }

        renderTodo();
        renderVocab();

        // 监听数据变更
        document.addEventListener("dw:dataChanged", (e) => {
            if (e.detail.key === SK.todos) renderTodo();
            if (e.detail.key === SK.vocabulary) renderVocab();
        });
    }

    function refresh() {
        renderTodo();
        renderVocab();
    }

    return { init, refresh };
})();
