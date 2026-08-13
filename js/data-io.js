/* =====================================================================
   data-io.js — 数据导入 / 导出模块
   ---------------------------------------------------------------------
   功能：
   - 导出：将 localStorage 中生词库、待办事项、心情记录合并为 JSON 下载
   - 导入：上传 JSON 文件，解析后覆盖写入 localStorage，刷新页面生效
   ===================================================================== */

const DataIO = (() => {
    const SK = window.APP_CONFIG.storageKeys;

    /* ---------- 收集所有需导出的数据 ---------- */
    function collectData() {
        const data = {};

        // 1. 生词库
        data.vocabulary = Api.store.get(SK.vocabulary, []);

        // 2. 待办事项（通用，不再按天）
        data.todos = Api.store.get(SK.todos, []);

        // 2b. 兼容旧的按天存储数据（迁移用）
        const legacyTodos = {};
        const legacyPrefix = SK.todosLegacy || "dw_todos_";
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(legacyPrefix)) {
                legacyTodos[key] = Api.store.get(key, []);
            }
        }
        if (Object.keys(legacyTodos).length) {
            data.todosLegacy = legacyTodos;
        }

        // 3. 心情记录
        data.moods = Api.store.get(SK.moods, {});

        return data;
    }

    /* ---------- 导出为 JSON 文件 ---------- */
    function exportData() {
        const data = collectData();
        const vocabCount = (data.vocabulary || []).length;
        const todoCount = (data.todos || []).length;
        const moodCount = Object.keys(data.moods || {}).length;

        const payload = {
            app: "我的每日学习工作台",
            version: "2.0",
            exportTime: new Date().toISOString(),
            summary: {
                vocabulary: vocabCount,
                todos: todoCount,
                moods: moodCount
            },
            data
        };

        const json = JSON.stringify(payload, null, 2);
        const blob = new Blob(["\ufeff" + json], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const ts = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `学习工作台备份_${ts}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        Api.showToast(`已导出：${vocabCount} 词 / ${todoCount} 待办 / ${moodCount} 天心情`, "success");
    }

    /* ---------- 导入 JSON 文件 ---------- */
    function handleImport(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const payload = JSON.parse(e.target.result);

                // 兼容两种格式：直接是 data 对象，或包在 .data 里
                const data = payload.data || payload;

                if (!data || typeof data !== "object") {
                    throw new Error("文件格式不正确");
                }

                // 确认覆盖
                const hasData = data.vocabulary || data.todos || data.todosLegacy || data.moods;
                if (!hasData) {
                    Api.showToast("文件中没有可导入的数据", "error");
                    return;
                }

                if (!confirm("导入将覆盖当前所有数据（生词库、待办、心情），确定继续吗？")) {
                    return;
                }

                // 写入数据
                let imported = { vocab: 0, todos: 0, moods: 0 };

                if (data.vocabulary) {
                    Api.store.set(SK.vocabulary, data.vocabulary);
                    imported.vocab = data.vocabulary.length;
                }

                if (data.todos) {
                    Api.store.set(SK.todos, data.todos);
                    imported.todos = data.todos.length;
                }

                // 迁移旧格式按天存储的待办
                if (data.todosLegacy) {
                    const existing = Api.store.get(SK.todos, []);
                    const merged = [...existing];
                    for (const key in data.todosLegacy) {
                        const items = data.todosLegacy[key];
                        for (const item of items) {
                            if (!merged.some(m => m.text === item.text && m.createdAt === item.createdAt)) {
                                merged.push(item);
                            }
                        }
                    }
                    Api.store.set(SK.todos, merged);
                    imported.todos = merged.length;
                }

                if (data.moods) {
                    Api.store.set(SK.moods, data.moods);
                    imported.moods = Object.keys(data.moods).length;
                }

                Api.showToast(`导入成功：${imported.vocab} 词 / ${imported.todos} 待办 / ${imported.moods} 天心情`, "success");

                // 刷新页面以应用所有变更
                setTimeout(() => location.reload(), 1200);

            } catch (err) {
                console.error("导入失败:", err);
                Api.showToast("导入失败：" + err.message, "error");
            }
        };
        reader.onerror = () => Api.showToast("文件读取失败", "error");
        reader.readAsText(file, "utf-8");
    }

    /* ---------- 初始化：绑定按钮 ---------- */
    function init() {
        const exportBtn = document.getElementById("btnExportData");
        const importBtn = document.getElementById("btnImportData");
        const importInput = document.getElementById("importFileInput");

        if (exportBtn) exportBtn.addEventListener("click", exportData);

        if (importBtn && importInput) {
            importBtn.addEventListener("click", () => importInput.click());
            importInput.addEventListener("change", (e) => {
                if (e.target.files && e.target.files[0]) {
                    handleImport(e.target.files[0]);
                    e.target.value = ""; // 允许重复导入同一文件
                }
            });
        }
    }

    return { init, exportData, handleImport };
})();
