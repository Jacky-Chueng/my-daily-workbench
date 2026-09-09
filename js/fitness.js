/* =====================================================================
   fitness.js — 训练建议模块（佳明数据 + 目标驱动）
   ---------------------------------------------------------------------
   数据从哪来：
     - 佳明数据（睡眠 / HRV / 静息心率 / 身体电量 / 压力 / 活动）由 WorkBuddy
       通过本机 garmin-mcp-cn 拉取，算好后写进 dw_fitness 的 metrics 字段，
       再经 Supabase 同步到所有设备。静态页面本身无法直连 Garmin（跨域+密钥）。
     - 每日建议（advice）优先用 WorkBuddy 生成的；若还没生成（比如刚打开、
       或临时想练），本模块会用前端规则算一条兜底建议，保证随时有东西看。

   算法移植自 claude-fitness-cn（MIT）的方法：
     - 准备度 1-10：base 5，按睡眠 / HRV(28天自身基线) / 静息心率 / 身体电量 / 压力调整
     - 配速区间：由目标成绩反推，轻松 / 长距离 / 节奏 / 间歇四档
     - 周结构：按距比赛周数分期（基础 / 进展 / 巅峰 / 减量）
     - 自适应：看最近 7 天实际跑量与近 28 天均值（ACWR 思路），超量就降量
   ===================================================================== */

const Fitness = (() => {
    const SK = window.APP_CONFIG.storageKeys;
    const KEY = SK.fitness;

    /* ---------- 赛事类型 ---------- */
    const RACES = {
        "5k": { name: "5 公里", km: 5 },
        "10k": { name: "10 公里", km: 10 },
        "half": { name: "半程马拉松", km: 21.0975 },
        "full": { name: "全程马拉松", km: 42.195 }
    };

    /* ---------- 课表类型 ---------- */
    const TYPES = {
        rest: { name: "休息", icon: "&#128564;", tone: "rest" },
        easy: { name: "轻松跑", icon: "&#127939;", tone: "easy" },
        long: { name: "长距离", icon: "&#128694;", tone: "long" },
        tempo: { name: "节奏跑", icon: "&#9889;", tone: "tempo" },
        interval: { name: "间歇", icon: "&#128293;", tone: "interval" },
        recovery: { name: "恢复跑", icon: "&#127807;", tone: "easy" },
        cross: { name: "交叉训练", icon: "&#129504;", tone: "easy" }
    };

    const WEEK_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

    const els = {
        today: () => document.getElementById("fitToday"),
        workout: () => document.getElementById("fitWorkout"),
        week: () => document.getElementById("fitWeek"),
        stats: () => document.getElementById("fitStats"),
        countdown: () => document.getElementById("fitnessCountdown"),
        settings: () => document.getElementById("fitSettings"),
        syncBtn: () => document.getElementById("fitSyncBtn"),
        syncHint: () => document.getElementById("fitSyncHint")
    };

    /* ================= 数据读写 ================= */
    function load() { return Api.store.get(KEY, {}) || {}; }
    function save(data) { Api.store.set(KEY, data); }

    /* ================= 小工具 ================= */
    function todayStr() { return Api.todayKey(); }

    function parseDate(s) {
        if (!s) return null;
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
        if (!m) return null;
        return new Date(+m[1], +m[2] - 1, +m[3]);
    }
    function daysUntil(dateStr) {
        const d = parseDate(dateStr);
        if (!d) return null;
        const t = new Date(); t.setHours(0, 0, 0, 0);
        return Math.round((d - t) / 86400000);
    }
    function weekdayOf(dateStr) { return parseDate(dateStr) ? parseDate(dateStr).getDay() : new Date().getDay(); }

    // 成绩文本 → 秒（支持 "1:45:00" / "45:00" / "105"）
    function timeToSec(txt) {
        if (txt == null) return null;
        const s = String(txt).trim();
        if (!s) return null;
        const parts = s.split(":").map(Number);
        if (parts.some(isNaN)) return null;
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        if (parts.length === 1) return parts[0] * 60;   // 纯数字按分钟
        return null;
    }
    function fmtPace(secPerKm) {
        if (!secPerKm || !isFinite(secPerKm)) return "—";
        const m = Math.floor(secPerKm / 60);
        const s = Math.round(secPerKm % 60);
        return m + "'" + String(s).padStart(2, "0") + '"';
    }
    function fmtDur(sec) {
        if (!sec || !isFinite(sec)) return "—";
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.round(sec % 60);
        if (h) return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
        return m + ":" + String(s).padStart(2, "0");
    }

    /* ================= 配速区间 =================
       由目标成绩反推比赛配速，再按经验系数推出各档训练配速 */
    function pacesFromGoal(goal) {
        if (!goal || !goal.targetTime) return null;
        const race = RACES[goal.type];
        if (!race) return null;
        const total = timeToSec(goal.targetTime);
        if (!total) return null;
        const racePace = total / race.km;                 // 秒/公里
        return {
            racePace,
            race: racePace,
            easy: racePace * 1.22,
            long: racePace * 1.14,
            tempo: racePace * 1.03,
            interval: racePace * 0.92,
            km: race.km,
            goalTime: total
        };
    }

    /* ================= 准备度 1-10 =================
       base 5，各项按与自身基线的偏离加减；数据缺失就跳过该项并记数 */
    function computeReadiness(m) {
        if (!m) return { score: null, inputs: 0, notes: [] };
        let score = 5, inputs = 0;
        const notes = [];

        // 睡眠：优先用睡眠评分，没有就用时长
        if (typeof m.sleepScore === "number") {
            inputs++;
            if (m.sleepScore >= 85) { score += 1.5; notes.push("睡眠很好"); }
            else if (m.sleepScore >= 70) { score += 0.5; }
            else if (m.sleepScore < 60) { score -= 1.5; notes.push("睡眠不足"); }
        } else if (typeof m.sleepHours === "number") {
            inputs++;
            if (m.sleepHours >= 8) { score += 1; }
            else if (m.sleepHours < 6) { score -= 1.5; notes.push("睡眠不足"); }
        }

        // HRV：与自己近 28 天基线比（±0.5 SD）
        if (typeof m.hrv === "number" && typeof m.hrvBaseline === "number" && m.hrvBaseline > 0) {
            inputs++;
            const sd = m.hrvSd || m.hrvBaseline * 0.1;
            const z = (m.hrv - m.hrvBaseline) / (sd || 1);
            if (z > 0.5) { score += 1.5; notes.push("HRV 高于自身基线"); }
            else if (z < -0.5) { score -= 1.5; notes.push("HRV 低于自身基线"); }
        }

        // 静息心率：比基线高说明疲劳
        if (typeof m.rhr === "number" && typeof m.rhrBaseline === "number" && m.rhrBaseline > 0) {
            inputs++;
            const d = m.rhr - m.rhrBaseline;
            if (d <= 0) { score += 1; }
            else if (d <= 3) { /* 正常波动 */ }
            else { score -= 1.5; notes.push("静息心率偏高"); }
        }

        // 身体电量
        if (typeof m.bodyBattery === "number") {
            inputs++;
            if (m.bodyBattery >= 70) { score += 1; }
            else if (m.bodyBattery < 40) { score -= 1.5; notes.push("身体电量低"); }
        }

        // 压力
        if (typeof m.stress === "number") {
            inputs++;
            if (m.stress <= 25) { score += 0.5; }
            else if (m.stress > 50) { score -= 1; notes.push("压力偏高"); }
        }

        score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));
        return { score, inputs, notes };
    }

    /* ================= 训练负荷 / 自适应 =================
       用最近 7 天跑量与近 28 天日均的比值（ACWR 思路）判断要不要降量 */
    function loadRatio(logs) {
        if (!logs || !logs.length) return null;
        const now = new Date(); now.setHours(0, 0, 0, 0);
        const kmOn = d => {
            const t = parseDate(d);
            if (!t) return 0;
            return Math.round((now - t) / 86400000);
        };
        let a = 0, c = 0;
        logs.forEach(l => {
            const age = kmOn(l.date);
            const km = Number(l.km) || 0;
            if (age >= 0 && age < 7) a += km;
            if (age >= 0 && age < 28) c += km;
        });
        const chronicDaily = c / 28;
        if (chronicDaily <= 0) return null;
        return { acute: a, chronicDaily: chronicDaily, ratio: a / (chronicDaily * 7) };
    }

    /* ================= 今日课表生成 ================= */
    function planPhase(weeksOut) {
        if (weeksOut == null) return "base";
        if (weeksOut < 2) return "taper";
        if (weeksOut < 4) return "peak";
        if (weeksOut < 10) return "build";
        return "base";
    }

    // 根据「今天是本周第几个训练日」分配课表类型
    function sessionForSlot(slotIndex, phase, readiness) {
        if (readiness != null && readiness <= 3.5) return "rest";
        const soft = readiness != null && readiness < 6.5;   // 状态一般 → 降强度
        if (phase === "taper") return slotIndex === 0 ? "tempo" : (soft ? "recovery" : "easy");
        if (phase === "peak") {
            if (slotIndex === 0) return soft ? "easy" : "interval";
            if (slotIndex === 1) return soft ? "easy" : "tempo";
            return "easy";
        }
        if (phase === "build") {
            if (slotIndex === 0) return soft ? "tempo" : "interval";
            if (slotIndex === 1) return "tempo";
            if (slotIndex === 2) return "long";
            return soft ? "recovery" : "easy";
        }
        // base
        if (slotIndex === 0) return soft ? "easy" : "tempo";
        if (slotIndex === 2 || slotIndex === 3) return "long";
        return "easy";
    }

    function suggestWorkout(data) {
        const today = todayStr();
        const wd = weekdayOf(today);
        const goal = data.goal || null;
        const days = Array.isArray(data.trainingDays) ? data.trainingDays.slice().sort((a, b) => a - b) : [];
        const m = data.metrics && data.metrics.date === today ? data.metrics : null;
        const r = computeReadiness(m);
        const paces = pacesFromGoal(goal);
        const weeksOut = goal && goal.raceDate ? (daysUntil(goal.raceDate) != null ? daysUntil(goal.raceDate) / 7 : null) : null;
        const phase = planPhase(weeksOut);
        const lr = loadRatio(data.logs);

        // 今天是不是训练日
        const isTrainingDay = days.length ? days.includes(wd) : null;
        const adHocToday = data.adHoc && data.adHoc.date === today;
        const wantTrain = isTrainingDay || adHocToday;

        // 本周第几个训练日（用于分配强度）
        let slotIndex = 0;
        if (isTrainingDay && days.length) {
            const passed = days.filter(d => d < wd).length;
            slotIndex = passed % Math.max(days.length, 1);
        }

        if (!wantTrain) {
            return {
                type: "rest", readiness: r, paces, weeksOut, phase, load: lr,
                headline: "今天是休息日",
                detail: r.score != null && r.score <= 4
                    ? "身体状态偏低，好好恢复比硬撑更值。建议散步 20-30 分钟或彻底休息。"
                    : "按你设定的训练日，今天不安排跑步。可以散步、拉伸或做核心力量，让身体吸收前面的训练。"
            };
        }

        let type = sessionForSlot(slotIndex, phase, r.score);
        // 负荷过高 → 强制降量（ACWR > 1.3）
        let overload = false;
        if (lr && lr.ratio > 1.3) {
            overload = true;
            if (type === "interval" || type === "tempo" || type === "long") type = "recovery";
        }
        // 临时加练：状态好才上强度，否则给轻松跑
        if (adHocToday && !isTrainingDay && (r.score == null || r.score < 6)) type = "easy";

        const w = buildSession(type, paces, weeksOut, phase, r.score, lr);
        return Object.assign({
            type, readiness: r, paces, weeksOut, phase, load: lr, overload,
            headline: (adHocToday && !isTrainingDay ? "临时加练 · " : "") + (TYPES[type] ? TYPES[type].name : "训练"),
            detail: w.detail
        }, w);
    }

    function buildSession(type, paces, weeksOut, phase, readiness, lr) {
        // 没有目标成绩时给保守的通用建议
        if (!paces) {
            const generic = {
                easy: { km: 6, detail: "轻松跑 6 公里，能正常说话的强度。设置比赛目标后我会按配速细化。" },
                long: { km: 12, detail: "长距离 12 公里，比轻松跑再慢一点，重点是把时间跑够。" },
                tempo: { km: 8, detail: "节奏跑：热身 2km + 4km 稍感吃力但能维持 + 放松 2km。" },
                interval: { km: 8, detail: "间歇：热身 2km + 6×400m（间休慢跑 90 秒）+ 放松 2km。" },
                recovery: { km: 4, detail: "恢复跑 4 公里，很慢，只为促进血液循环。" },
                cross: { km: 0, detail: "交叉训练：骑车 / 游泳 / 椭圆机 30-40 分钟，低强度。" },
                rest: { km: 0, detail: "今天休息。" }
            }[type] || { km: 5, detail: "轻松活动一下。" };
            return generic;
        }
        const p = paces;
        const longKm = Math.min(p.km * 0.85, Math.max(12, (lr && lr.chronicDaily ? lr.chronicDaily * 7 : 30) * 0.35));
        switch (type) {
            case "interval":
                return {
                    km: 10,
                    pace: p.interval,
                    detail: `热身 2km（${fmtPace(p.easy)}）→ 6×800m @ ${fmtPace(p.interval)}，间休慢跑 90 秒 → 放松 2km。`
                };
            case "tempo":
                return {
                    km: 9,
                    pace: p.tempo,
                    detail: `热身 2km → 5km 节奏跑 @ ${fmtPace(p.tempo)}（略吃力但能说短句）→ 放松 2km。`
                };
            case "long":
                return {
                    km: Math.round(longKm),
                    pace: p.long,
                    detail: `长距离 ${Math.round(longKm)}km @ ${fmtPace(p.long)}，全程能正常对话；最后 2km 可略提速找找比赛感觉。`
                };
            case "recovery":
                return { km: 5, pace: p.easy, detail: `恢复跑 5km @ ${fmtPace(p.easy)}，很慢，重点是放松。` };
            case "cross":
                return { km: 0, detail: "交叉训练 30-40 分钟低强度有氧。" };
            case "rest":
                return { km: 0, detail: "今天休息，让身体吸收训练。" };
            default:
                return {
                    km: 7,
                    pace: p.easy,
                    detail: `轻松跑 7km @ ${fmtPace(p.easy)}，能完整说句子的强度。`
                };
        }
    }

    /* ================= 渲染 ================= */
    function render() {
        const data = load();
        const today = todayStr();

        // 倒计时
        const cd = els.countdown();
        if (cd) {
            const d = data.goal && data.goal.raceDate ? daysUntil(data.goal.raceDate) : null;
            cd.textContent = d == null ? "未设目标" : (d >= 0 ? `距比赛 ${d} 天` : "已过比赛日");
        }

        // 今日状态
        const t = els.today();
        if (t) t.innerHTML = renderTodayHtml(data, today);

        // 今日课表
        const w = els.workout();
        if (w) w.innerHTML = renderWorkoutHtml(data, today);

        // 本周安排
        const wk = els.week();
        if (wk) wk.innerHTML = renderWeekHtml(data, today);

        // 近况
        const st = els.stats();
        if (st) st.innerHTML = renderStatsHtml(data);

        // 同步状态提示
        const h = els.syncHint();
        if (h) {
            const sr = data.syncRequest;
            if (sr && sr.status === "pending") {
                const ago = Math.max(0, Math.round((Date.now() - (sr.requestedAt || 0)) / 1000));
                h.textContent = `已请求同步佳明 · ${ago < 5 ? "马上" : "通常 30 秒内"}到位`;
                h.classList.remove("hidden");
            } else if (sr && sr.status === "done") {
                h.textContent = "✓ 已同步最新数据";
                h.classList.remove("hidden");
            } else {
                h.classList.add("hidden");
            }
        }

        // "去设置"链接
        const goto = document.getElementById("fitWeekGoto");
        if (goto && !goto._bound) {
            goto._bound = true;
            goto.addEventListener("click", e => {
                e.preventDefault();
                const box = els.settings();
                renderSettings();
                box.classList.remove("hidden");
                box.scrollIntoView({ behavior: "smooth", block: "center" });
            });
        }

        bindEvents();
    }

    function renderTodayHtml(data, today) {
        const m = data.metrics && data.metrics.date === today ? data.metrics : null;
        if (!m) {
            return `<div class="fit-empty">
                <div class="fit-empty-icon">⌚</div>
                <div class="fit-empty-title">还没有今天的身体数据</div>
                <div class="fit-empty-hint">佳明数据由 WorkBuddy 每天早上自动拉取并同步过来。<br>没配的话跟我说一声「配一下佳明」就行。</div>
            </div>`;
        }
        const r = computeReadiness(m);
        const pct = r.score != null ? (r.score / 10) * 100 : 0;
        const tone = r.score == null ? "" : (r.score >= 7.5 ? "good" : r.score >= 5.5 ? "ok" : "bad");
        const label = r.score == null ? "—" : (r.score >= 7.5 ? "状态良好" : r.score >= 6.5 ? "可按计划执行" : r.score >= 4 ? "建议降量" : "建议休息");

        // 关键指标（含与基线的相对箭头）
        const trend = (val, base) => {
            if (val == null || base == null) return "";
            const d = val - base;
            if (Math.abs(d) < 1) return "→";
            return d > 0 ? "↑" : "↓";
        };
        const cells = [
            { k: "HRV", v: m.hrv, base: m.hrvBaseline, sym: trend(m.hrv, m.hrvBaseline), lower: m.hrvStatus === "UNBALANCED" },
            { k: "静息心率", v: m.rhr, base: m.rhrBaseline, sym: trend(m.rhr, m.rhrBaseline) },
            { k: "睡眠", v: m.sleepScore ?? (m.sleepHours != null ? m.sleepHours + "h" : null), base: null, sym: "" },
            { k: "电量", v: m.bodyBattery, base: null, sym: m.bodyBattery != null && m.bodyBattery < 40 ? "↓" : "" },
            { k: "压力", v: m.stress, base: null, sym: m.stress != null && m.stress > 50 ? "↑" : "" }
        ];

        return `
        <div class="fit-readiness ${tone}">
            <div class="fit-readiness-num-wrap">
                <span class="fit-readiness-num">${r.score != null ? r.score : "—"}</span><span class="fit-readiness-max">/ 10</span>
            </div>
            <div class="fit-readiness-meta">
                <div class="fit-readiness-label">${label}${r.inputs ? ` <span>· ${r.inputs} 项数据</span>` : ""}</div>
                <div class="fit-bar"><i style="width:${pct}%"></i></div>
                ${r.notes.length ? `<div class="fit-notes">${r.notes.map(n => escapeHtml(n)).join(" · ")}</div>` : ""}
            </div>
        </div>
        <div class="fit-metrics">
            ${cells.map(c => `<div class="fit-metric${c.lower ? " is-bad" : ""}">
                <div class="fit-metric-v">${c.v != null ? c.v : "—"}${c.sym ? `<i class="fit-metric-sym">${c.sym}</i>` : ""}</div>
                <div class="fit-metric-k">${c.k}${c.base != null ? `<span>/ ${c.base}</span>` : ""}</div>
            </div>`).join("")}
        </div>`;
    }

    function renderWorkoutHtml(data, today) {
        const s = suggestWorkout(data);
        const T = TYPES[s.type] || TYPES.easy;
        const advice = data.advice && data.advice.date === today ? data.advice : null;
        const w = (advice && advice.workout) || {};
        const tone = w.tone || T.tone;
        const type = w.type || s.type;
        const name = (advice && advice.headline) || s.headline;
        const km = w.km || s.km;
        const pace = w.pace || s.pace;
        const isFallback = !advice;

        const flags = (w && Array.isArray(w.flags)) ? w.flags : (s.overload && s.load ? [`负荷比 ${s.load.ratio.toFixed(2)} 超出安全区 0.8-1.3`] : []);
        const detailText = (advice && advice.detail) || s.detail || "";

        return `
        <div class="fit-session tone-${tone}">
            <div class="fit-session-head">
                <span class="fit-session-icon">${T.icon}</span>
                <span class="fit-session-type">${escapeHtml(name || T.name)}</span>
            </div>
            <div class="fit-session-hero">
                ${km ? `<div class="fit-session-distance">${km}<small>km</small></div>` : `<div class="fit-session-distance">—</div>`}
                ${pace ? `<div class="fit-session-pace">${pace ? (typeof pace === "number" ? fmtPace(pace) : escapeHtml(String(pace))) : ""}<small>/km</small></div>` : ""}
            </div>
            <div class="fit-session-detail">${escapeHtml(detailText).replace(/\n/g, "<br>")}</div>
            ${flags.length ? `<div class="fit-warn">⚠ ${flags.map(escapeHtml).join(" · ")}</div>` : ""}
            ${isFallback ? `<div class="fit-session-src">本地规则估算（今天的佳明建议还没出来）</div>` : ""}
        </div>`;
    }

    function renderWeekHtml(data, today) {
        const days = Array.isArray(data.trainingDays) ? data.trainingDays : [];
        const wd = weekdayOf(today);
        const order = [1, 2, 3, 4, 5, 6, 0];
        const cells = order.map(d => {
            const on = days.includes(d);
            const isToday = d === wd;
            return `<div class="fit-day ${on ? "on" : ""} ${isToday ? "today" : ""}" title="${on ? "训练日" : "休息日"}">
                <div class="fit-day-name">${WEEK_NAMES[d]}</div>
                <div class="fit-day-dot${on ? " on" : ""}"></div>
            </div>`;
        }).join("");
        const hint = !days.length
            ? `<div class="fit-week-hint">还没选训练日 · <a href="#" id="fitWeekGoto">去设置</a></div>`
            : "";
        return `<div class="fit-week-head">本周训练日</div><div class="fit-week">${cells}</div>${hint}`;
    }

    function renderStatsHtml(data) {
        const m = data.metrics || null;
        const today = todayStr();
        const km7 = m && m.last7Km != null ? m.last7Km : (countKm(data.logs, 7) || 0);
        const km28 = m && m.last28Km != null ? m.last28Km : (countKm(data.logs, 28) || 0);
        const runCount7 = m && m.runCount7 != null ? m.runCount7 : (countRuns(data.logs, 7) || 0);
        const lr = loadRatio(data.logs || []);
        const acwr = lr && lr.ratio ? lr.ratio.toFixed(2) : "—";
        const acwrTone = !lr ? "" : (lr.ratio > 1.3 ? "bad" : lr.ratio < 0.8 ? "ok" : "good");

        return `<div class="fit-stats">
            <div class="fit-stat">
                <div class="fit-stat-num">${km7}<small>km</small></div>
                <div class="fit-stat-label">近 7 天</div>
            </div>
            <div class="fit-stat">
                <div class="fit-stat-num">${runCount7}<small>次</small></div>
                <div class="fit-stat-label">本周跑步</div>
            </div>
            <div class="fit-stat">
                <div class="fit-stat-num">${km28}<small>km</small></div>
                <div class="fit-stat-label">近 28 天</div>
            </div>
            <div class="fit-stat ${acwrTone}">
                <div class="fit-stat-num">${acwr}</div>
                <div class="fit-stat-label">负荷比<br><span class="fit-stat-sub">0.8-1.3</span></div>
            </div>
        </div>`;
    }

    function countKm(logs, days) {
        if (!logs) return 0;
        const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - days);
        let s = 0;
        logs.forEach(l => {
            const d = parseDate(l.date);
            if (d && d >= cutoff) s += Number(l.km) || 0;
        });
        return Math.round(s * 100) / 100;
    }
    function countRuns(logs, days) {
        if (!logs) return 0;
        const cutoff = new Date(); cutoff.setHours(0, 0, 0, 0); cutoff.setDate(cutoff.getDate() - days);
        return logs.filter(l => {
            const d = parseDate(l.date);
            return d && d >= cutoff;
        }).length;
    }

    function fmtTime(ts) {
        if (!ts) return "";
        const d = new Date(ts);
        return String(d.getMonth() + 1) + "月" + d.getDate() + "日 " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }

    /* ================= 目标设置面板 ================= */
    function renderSettings() {
        const box = els.settings();
        if (!box) return;
        const data = load();
        const g = data.goal || {};
        const days = Array.isArray(data.trainingDays) ? data.trainingDays : [];
        box.innerHTML = `
        <div class="fit-form-row">
            <label>比赛项目</label>
            <select id="fitRaceType" class="input">
                ${Object.keys(RACES).map(k => `<option value="${k}" ${g.type === k ? "selected" : ""}>${RACES[k].name}</option>`).join("")}
            </select>
        </div>
        <div class="fit-form-row">
            <label>目标成绩</label>
            <input id="fitTarget" class="input" type="text" placeholder="如 1:45:00（半马）/ 45:00（10K）" value="${escapeHtml(g.targetTime || "")}">
        </div>
        <div class="fit-form-row">
            <label>比赛日期</label>
            <input id="fitDate" class="input" type="date" value="${escapeHtml(g.raceDate || "")}">
        </div>
        <div class="fit-form-row">
            <label>每周训练日</label>
            <div class="fit-daypick" id="fitDayPick">
                ${[1, 2, 3, 4, 5, 6, 0].map(d => `
                    <button type="button" class="fit-daybtn ${days.includes(d) ? "on" : ""}" data-d="${d}">周${WEEK_NAMES[d]}</button>
                `).join("")}
            </div>
        </div>
        <div class="fit-form-actions">
            <button id="fitSaveGoal" class="btn btn-primary btn-sm" type="button">保存</button>
            <button id="fitCancelGoal" class="btn btn-ghost btn-sm" type="button">取消</button>
        </div>
        <div class="fit-hint">目标配速会按目标成绩自动换算；训练日决定我给你排课的日子，其他日子默认休息（想临时练点上面的按钮）。</div>`;

        box.querySelectorAll(".fit-daybtn").forEach(b => {
            b.addEventListener("click", () => b.classList.toggle("on"));
        });
        document.getElementById("fitSaveGoal").addEventListener("click", saveGoal);
        document.getElementById("fitCancelGoal").addEventListener("click", () => { box.classList.add("hidden"); });
    }

    function saveGoal() {
        const type = document.getElementById("fitRaceType").value;
        const targetTime = document.getElementById("fitTarget").value.trim();
        const raceDate = document.getElementById("fitDate").value;
        const days = Array.from(document.querySelectorAll("#fitSettings .fit-daybtn.on"))
            .map(b => Number(b.dataset.d));

        const data = load();
        data.goal = { type, targetTime, raceDate, updatedAt: Date.now() };
        data.trainingDays = days;
        save(data);
        els.settings().classList.add("hidden");
        render();
        Api.showToast("目标已保存，下次生成建议会按新目标来", "success");
    }

    /* ================= 临时加练 ================= */
    function requestAdHoc() {
        const data = load();
        const today = todayStr();
        data.adHoc = { date: today, requestedAt: Date.now(), status: "pending" };
        save(data);
        render();
        Api.showToast("已记录：今天要练。建议已临时生成，我下次同步时会按你实际状态微调后续安排", "success");
    }

    /* ================= 同步佳明 =================
       页面不能直连佳明（佳明 token 在本机），所以"点一下同步"的实现是：
       把同步请求写进 Supabase 标记（syncRequest pending），
       本机每 30 秒巡一次的守护进程会检测到并在 30 秒内拉取最新数据写回。 */
    async function markSyncRequest() {
        const cfg = window.APP_CONFIG && window.APP_CONFIG.supabase;
        if (!cfg || !cfg.enabled || !cfg.url || !window.supabase) {
            return { ok: false, reason: "云同步未配置" };
        }
        try {
            const c = window.supabase.createClient(cfg.url, cfg.anonKey);
            const { data: rows } = await c.from("sync_data")
                .select("payload").eq("id", cfg.syncId).maybeSingle();
            const payload = (rows && rows.payload) || {};
            const fit = payload.fitness || {};
            fit.syncRequest = { requestedAt: Date.now(), status: "pending" };
            payload.fitness = fit;
            const { error } = await c.from("sync_data").upsert({
                id: cfg.syncId,
                payload,
                updated_at: new Date().toISOString()
            });
            if (error) throw error;
            return { ok: true };
        } catch (e) {
            console.error("markSyncRequest failed:", e);
            return { ok: false, reason: e.message || String(e) };
        }
    }

    async function requestSync() {
        const btn = els.syncBtn();
        if (!btn) return;
        const orig = btn.textContent;
        btn.disabled = true; btn.textContent = "请求中…";
        const showHint = (msg) => {
            const h = els.syncHint();
            if (!h) return;
            h.textContent = msg;
            h.classList.remove("hidden");
        };
        // 本地存在就立即给个反馈；标记 pending 也会立刻反映到本页（云同步 Realtime）
        showHint("已请求同步 · 通常 30 秒内到位");
        const r = await markSyncRequest();
        btn.disabled = false; btn.textContent = orig;
        if (!r.ok) {
            showHint("请求失败：" + (r.reason || "网络问题") + " · 试试告诉 WorkBuddy 手动拉一下");
            Api.showToast("同步请求失败，建议直接说「同步一下佳明」", "error");
        } else {
            // 立刻在本地数据里也置一个 pending 标记，刷新会显示
            const data = load();
            data.syncRequest = { requestedAt: Date.now(), status: "pending" };
            save(data);
            render();
        }
    }

    /* ================= 事件绑定 ================= */
    function bindEvents() {
        const adhoc = document.getElementById("fitAdHocBtn");
        if (adhoc && !adhoc._bound) {
            adhoc._bound = true;
            adhoc.addEventListener("click", requestAdHoc);
        }
        const sync = els.syncBtn();
        if (sync && !sync._bound) {
            sync._bound = true;
            sync.addEventListener("click", requestSync);
        }
        const setBtn = document.getElementById("fitSettingsBtn");
        if (setBtn && !setBtn._bound) {
            setBtn._bound = true;
            setBtn.addEventListener("click", () => {
                const box = els.settings();
                renderSettings();
                box.classList.toggle("hidden");
            });
        }
    }

    /* ================= 初始化 ================= */
    function init() {
        render();
        document.addEventListener("dw:dataChanged", e => {
            if (e.detail && e.detail.key === KEY) render();
        });
        document.addEventListener("dw:remoteSynced", render);
    }

    function refresh() { render(); }

    return { init, refresh, load, save, suggestWorkout, computeReadiness, pacesFromGoal };
})();
