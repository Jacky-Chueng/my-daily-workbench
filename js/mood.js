/* =====================================================================
   mood.js — 每日心情记录模块
   ---------------------------------------------------------------------
   - 6 种心情表情可选 + 文字备注
   - 每天可保存/覆盖一次
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
        history: () => document.getElementById("moodHistory")
    };

    let selectedMood = "";

    function loadAll() { return Api.store.get(KEY, {}); }
    function saveAll(data) { Api.store.set(KEY, data); }

    /* ---------- 渲染选中态 ---------- */
    function renderSelected() {
        els.picker().querySelectorAll(".mood-btn").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.mood === selectedMood);
        });
    }

    /* ---------- 渲染全部历史（按日期降序） ---------- */
    function renderHistory() {
        const all = loadAll();
        const list = els.history();
        if (!list) return;

        // 取所有有记录的日期，降序排列
        const dates = Object.keys(all).filter(d => all[d] && all[d].mood).sort((a, b) => b.localeCompare(a));

        if (!dates.length) {
            list.innerHTML = '<li class="mood-history-empty">还没有心情记录，选个表情开始吧～</li>';
            return;
        }

        list.innerHTML = dates.map(d => {
            const r = all[d];
            return `
                <li class="mood-history-item">
                    <span class="mood-history-emoji" title="${MOOD_LABELS[r.mood] || ""}">${r.mood}</span>
                    <span class="mood-history-date">${Api.friendlyDate(d)}</span>
                    <span class="mood-history-note">${escapeHtml(r.note || "")}</span>
                </li>
            `;
        }).join("");
    }

    /* ---------- 回显今日已存记录 ---------- */
    function loadToday() {
        const all = loadAll();
        const today = Api.todayKey();
        const todayRecord = all[today];
        if (todayRecord) {
            selectedMood = todayRecord.mood;
            els.note().value = todayRecord.note || "";
            renderSelected();
        }
    }

    /* ---------- 保存 ---------- */
    function save() {
        if (!selectedMood) {
            Api.showToast("请先选择一个心情表情", "error");
            return;
        }
        const all = loadAll();
        all[Api.todayKey()] = {
            mood: selectedMood,
            note: els.note().value.trim(),
            savedAt: Date.now()
        };
        saveAll(all);
        renderHistory();
        Api.showToast("今日心情已保存 💾", "success");
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

        loadToday();
        renderHistory();
    }

    function refresh() {
        loadToday();
        renderHistory();
    }

    return { init, refresh };
})();
