/* =====================================================================
   vocabulary.js — 生词库模块
   ---------------------------------------------------------------------
   功能：
   - 监听文章区域选中单词，浮出"添加到生词库"按钮
   - 添加单词时自动翻译释义并存入 localStorage
   - 列表展示、单条删除、清空
   - 导出 TXT / JSON
   ===================================================================== */

const Vocab = (() => {
    const KEY = window.APP_CONFIG.storageKeys.vocabulary;
    let words = Api.store.get(KEY, []);

    /* ---------- DOM ---------- */
    const els = {
        list: () => document.getElementById("vocabList"),
        count: () => document.getElementById("vocabCount"),
        bar: () => document.getElementById("selectionBar"),
        word: () => document.getElementById("selectionWord"),
        addBtn: () => document.getElementById("addWordBtn")
    };

    /* ---------- 渲染 ---------- */
    function render() {
        const list = els.list();
        const count = els.count();
        if (count) count.textContent = words.length;

        if (!words.length) {
            list.innerHTML = '<li class="empty-hint">暂无生词。在上方文章中选中单词即可添加。</li>';
            return;
        }

        list.innerHTML = words.map((w, i) => `
            <li class="vocab-item">
                <span class="vocab-word">${escapeHtml(w.word)}</span>
                <span class="vocab-meaning">${escapeHtml(w.meaning || "（无释义）")}</span>
                <span class="vocab-date">${w.date || ""}</span>
                <button class="vocab-del" data-idx="${i}" title="删除">✕</button>
            </li>
        `).join("");

        // 绑定删除
        list.querySelectorAll(".vocab-del").forEach(btn => {
            btn.addEventListener("click", () => remove(Number(btn.dataset.idx)));
        });
    }

    function save() { Api.store.set(KEY, words); }

    /* ---------- 增删 ---------- */
    async function add(word) {
        word = word.trim();
        if (!word) return;
        // 去重
        if (words.some(w => w.word.toLowerCase() === word.toLowerCase())) {
            Api.showToast("该单词已在生词库中", "");
            return;
        }

        // 尝试翻译释义（英→中）
        let meaning = "";
        try {
            meaning = await Api.translateText(word, { source: "en", target: "zh" });
        } catch {
            meaning = ""; // 翻译失败也允许添加
        }

        words.unshift({
            word,
            meaning,
            date: Api.todayKey()
        });
        save();
        render();
        Api.showToast(`已添加 "${word}"`, "success");
    }

    function remove(idx) {
        if (idx < 0 || idx >= words.length) return;
        const removed = words.splice(idx, 1)[0];
        save();
        render();
        Api.showToast(`已删除 "${removed.word}"`, "");
    }

    function clearAll() {
        if (!words.length) { Api.showToast("生词库已是空的", ""); return; }
        if (!confirm(`确定清空全部 ${words.length} 个生词吗？此操作不可恢复。`)) return;
        words = [];
        save();
        render();
        Api.showToast("已清空生词库", "");
    }

    /* ---------- 导出 ---------- */
    function exportTxt() {
        if (!words.length) { Api.showToast("生词库为空，无可导出内容", ""); return; }
        const text = words.map(w =>
            `${w.word}\t${w.meaning || ""}\t${w.date || ""}`
        ).join("\n");
        const header = "# 我的每日学习工作台 - 生词库\n"
            + `# 导出时间：${new Date().toLocaleString()}\n`
            + `# 共 ${words.length} 个单词\n\n`
            + "单词\t释义\t添加日期\n";
        download(header + text, "生词库.txt", "text/plain;charset=utf-8");
        Api.showToast("已导出 TXT", "success");
    }

    function exportJson() {
        if (!words.length) { Api.showToast("生词库为空，无可导出内容", ""); return; }
        const data = {
            exportTime: new Date().toISOString(),
            count: words.length,
            words
        };
        download(JSON.stringify(data, null, 2), "生词库.json", "application/json;charset=utf-8");
        Api.showToast("已导出 JSON", "success");
    }

    function download(content, filename, mime) {
        const blob = new Blob(["\ufeff" + content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /* ---------- 选中单词监听 ---------- */
    function initSelectionListener() {
        const articleBody = document.getElementById("articleBody");
        if (!articleBody) return;

        document.addEventListener("mouseup", () => {
            const sel = window.getSelection();
            const text = sel ? sel.toString().trim() : "";
            // 仅在文章区域内选中、且选中内容是单个英文单词时显示
            if (text && articleBody.contains(sel.anchorNode)) {
                const clean = text.replace(/[^a-zA-Z'-]/g, "");
                if (clean.length >= 1 && clean.length <= 40 && !/\s/.test(clean)) {
                    showBar(clean);
                    return;
                }
            }
            hideBar();
        });

        // 触摸端
        articleBody.addEventListener("touchend", () => {
            setTimeout(() => {
                const sel = window.getSelection();
                const text = sel ? sel.toString().trim() : "";
                if (text && articleBody.contains(sel.anchorNode)) {
                    const clean = text.replace(/[^a-zA-Z'-]/g, "");
                    if (clean.length >= 1 && clean.length <= 40) {
                        showBar(clean);
                    }
                }
            }, 100);
        });

        els.addBtn().addEventListener("click", () => {
            const word = els.word().textContent;
            add(word);
            hideBar();
            window.getSelection().removeAllRanges();
        });
    }

    let currentWord = "";
    function showBar(word) {
        currentWord = word;
        els.word().textContent = word;
        els.bar().classList.remove("hidden");
    }

    function hideBar() {
        els.bar().classList.add("hidden");
    }

    /* ---------- 初始化 ---------- */
    function init() {
        render();
        initSelectionListener();

        document.getElementById("exportTxt").addEventListener("click", exportTxt);
        document.getElementById("exportJson").addEventListener("click", exportJson);
        document.getElementById("clearVocab").addEventListener("click", clearAll);
    }

    return { init, add, render };
})();

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}
