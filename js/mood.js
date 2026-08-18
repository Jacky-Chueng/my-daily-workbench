/* =====================================================================
   mood.js — 每日心情记录模块
   ---------------------------------------------------------------------
   - 6 种心情表情可选 + 文字备注
   - 每天可保存/覆盖一次
   - 支持编辑、删除任意历史记录（点历史条目上的按钮，载入上方编辑器修改）
   - 展示所有历史心情记录（按日期降序，不限天数）
   - 数据保存在 localStorage
   ===================================================================== */

const Mood = (() => {
    const KEY = window.APP_CONFIG.storageKeys.moods;

    const MOOD_LABELS = {
        "😊": "开心", "😐": "平静", "😢": "难过",
        "😡": "生气", "😴": "疲惫", "🥰": "幸福"
    };

    const els = {
        picker: () => document.getElementById("moodPicker"),
        note: () => document.getElementById("moodNote"),
        save: () => document.getElementById("saveMood"),
        history: () => document.getElementById("moodHistory"),
        banner: () => document.getElementById("moodEditBanner"),
        bannerDate: () => document.getElementById("moodEditDate"),
        bannerCancel: () => document.getElementById("moodEditCancel")
    };

    let selectedMood = "";
    let editingDate = null; // null = 编辑今天；否则为正在编辑的历史日期

    function loadAll() { return Api.store.get(KEY, {}); }
    function saveAll(data) { Api.store.set(KEY, data); }

    /* ---------- 渲染选中态 ---------- */
    function renderSelected() {
        els.picker().querySelectorAll(".mood-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.mood === selectedMood);
        });
    }

    /* ---------- 渲染全部历史（按日期降序）---------- */
    function renderHistory() {
        const all = loadAll();
        const list = els.history();
        if (!list) return;

        const dates = Object.keys(all).filter(d => all[d] && all[d].mood && !all[d]._deleted).sort((a, b) => b.localeCompare(a));

        if (!dates.length) {
            list.innerHTML = '<li class="mood-history-empty">还没有心情记录，选个表情开始吧～</li>';
            return;
        }

        list.innerHTML = dates.map(d => {
            const r = all[d];
            const editingCls = (d === editingDate) ? " editing" : "";
            return `
                <li class="mood-history-item${editingCls}">
                    <span class="mood-history-emoji" title="${MOOD_LABELS[r.mood] || ""}">${r.mood}</span>
                    <span class="mood-history-date">${Api.friendlyDate(d)}</span>
                    <span class="mood-history-note">${escapeHtml(r.note || "")}</span>
                    <span class="mood-history-actions">
                        <button class="mood-edit" data-date="${d}" title="编辑">✎</button>
                        <button class="mood-del" data-date="${d}" title="删除">✕</button>
                    </span>
                </li>`;
        }).join("");

        list.querySelectorAll(".mood-edit").forEach(btn => {
            btn.addEventListener("click", () => startEdit(btn.dataset.date));
        });
        list.querySelectorAll(".mood-del").forEach(btn => {
            btn.addEventListener("click", () => removeRecord(btn.dataset.date));
        });
    }

    /* ---------- 编辑某条历史记录 ---------- */
    function startEdit(date) {
        const all = loadAll();
        const rec = all[date];
        if (!rec) return;
        editingDate = date;
        selectedMood = rec.mood;
        els.note().value = rec.note || "";
        renderSelected();
        renderHistory();
        els.save().textContent = "更新该记录";
        // 显示提示条
        if (els.banner() && els.bannerDate()) {
            els.banner().hidden = false;
            els.bannerDate().textContent = Api.friendlyDate(date);
        }
        // 滚动到编辑器
        const card = document.getElementById("moodCard");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
        Api.showToast("正在编辑该条记录，修改后点保存", "");
    }

    function cancelEdit() {
        editingDate = null;
        if (els.banner()) els.banner().hidden = true;
        if (els.save()) els.save().textContent = "保存今日心情";
        loadToday();      // 回到今天的记录
        renderHistory();
    }

    /* ---------- 回显今日已存记录 ---------- */
    function loadToday() {
        const all = loadAll();
        const today = Api.todayKey();
        const todayRecord = all[today];
        if (todayRecord) {
            selectedMood = todayRecord.mood;
            els.note().value = todayRecord.note || "";
        } else {
            selectedMood = "";
            els.note().value = "";
        }
        renderSelected();
    }

    /* ---------- 保存（今天 或 正在编辑的历史日期）---------- */
    function save() {
        if (!selectedMood) {
            Api.showToast("请先选择一个心情表情", "error");
            return;
        }
        const all = loadAll();
        const target = editingDate || Api.todayKey();
        all[target] = {
            mood: selectedMood,
            note: els.note().value.trim(),
            savedAt: Date.now()
        };
        saveAll(all);

        if (editingDate) {
            editingDate = null;
            if (els.banner()) els.banner().hidden = true;
            if (els.save()) els.save().textContent = "保存今日心情";
            Api.showToast(`已更新 ${Api.friendlyDate(target)} 的心情 💾`, "success");
        } else {
            Api.showToast("今日心情已保存 💾", "success");
        }
        renderHistory();
    }

    /* ---------- 删除某条历史记录 ---------- */
    function removeRecord(date) {
        if (!confirm(`确定删除 ${Api.friendlyDate(date)} 的心情记录吗？`)) return;
        const all = loadAll();
        // 墓碑式删除：标记 _deleted，使其随云同步传到其他设备（对象合并不会传播"删除键"）
        if (all[date]) {
            all[date]._deleted = true;
            all[date]._deletedAt = Date.now();
        }
        saveAll(all);
        if (editingDate === date) cancelEdit();
        else renderHistory();
        Api.showToast("已删除该条记录", "success");
    }

    /* ---------- 初始化 ---------- */
    function init() {
        els.picker().querySelectorAll(".mood-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                selectedMood = btn.dataset.mood;
                renderSelected();
            });
        });

        els.save().addEventListener("click", save);
        if (els.bannerCancel()) els.bannerCancel().addEventListener("click", cancelEdit);

        loadToday();
        renderHistory();

        // 云端同步完成后（其他设备改了数据）刷新历史列表
        document.addEventListener("dw:remoteSynced", renderHistory);
    }

    function refresh() {
        loadToday();
        renderHistory();
    }

    return { init, refresh };
})();
