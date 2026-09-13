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

    // 可手动标记的课型（跑完点一下，算法按真实课型算负荷，而非用距离猜）
    const MANUAL_TYPES = [
        { key: "easy", name: "轻松跑" },
        { key: "long", name: "长距离" },
        { key: "tempo", name: "节奏跑" },
        { key: "interval", name: "间歇" },
        { key: "recovery", name: "恢复跑" },
        { key: "cross", name: "交叉训练" }
    ];

    const WEEK_NAMES = ["日", "一", "二", "三", "四", "五", "六"];
    const PHASE_NAMES = { base: "基础期", build: "进展期", peak: "巅峰期", taper: "减量期" };
    const phaseName = p => PHASE_NAMES[p] || p || "";

    const els = {
        today: () => document.getElementById("fitToday"),
        workout: () => document.getElementById("fitWorkout"),
        manualType: () => document.getElementById("fitManualType"),
        week: () => document.getElementById("fitWeek"),
        stats: () => document.getElementById("fitStats"),
        plan: () => document.getElementById("fitPlan"),
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
    // totalSlots = 每周训练天数；长距离永远只放在**本周最后一个训练日**，避免连续两天都是长距离。
    function sessionForSlot(slotIndex, phase, readiness, totalSlots) {
        if (readiness != null && readiness <= 3.5) return "rest";
        const soft = readiness != null && readiness < 6.5;
        const isLast = totalSlots > 1 && slotIndex === totalSlots - 1;
        if (phase === "taper") {
            return isLast ? "tempo" : (soft ? "recovery" : "easy");
        }
        if (phase === "peak") {
            if (isLast) return "long";
            if (slotIndex === 0) return soft ? "easy" : "interval";
            if (slotIndex === 1) return soft ? "easy" : "tempo";
            return "easy";
        }
        if (phase === "build") {
            if (isLast) return "long";
            if (slotIndex === 0) return soft ? "tempo" : "interval";
            if (slotIndex === 1) return "tempo";
            return soft ? "recovery" : "easy";
        }
        // base
        if (isLast) return "long";
        if (slotIndex === 0) return soft ? "easy" : "tempo";
        if (slotIndex === 1) return "tempo";
        return soft ? "recovery" : "easy";
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

        let type = sessionForSlot(slotIndex, phase, r.score, Math.max(days.length, 1));
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

    /* ================= 视觉小件（内联 SVG，替代 emoji） ================= */
    const ICONS = {
        tempo: '<path d="M9 1.4 3.1 9.5h3.7L5.5 14.6 12 6.5H8.3z" fill="currentColor" stroke="none"/>',
        interval: '<path d="M2 12.4h2.6V7.2H2zM6.7 12.4h2.6V3.2H6.7zM11.4 12.4H14V5.6h-2.6z" fill="currentColor" stroke="none"/>',
        long: '<path d="M2.4 13.2 6.6 4.4l2.2 4.8 1.6-2.9 2.6 6.9"/>',
        easy: '<path d="M12.4 3.1A6.2 6.2 0 0 0 3 8.3c0 2.3 1.5 4.2 3 4.2 1.2 0 1.7-1 2.5-2.2.7-1.1 1.4-2 2.6-2 1.3 0 2.2 1.2 2.2 1.2"/>',
        rest: '<path d="M12.8 9.6A5.7 5.7 0 0 1 6.2 2a5.7 5.7 0 1 0 6.6 7.6z"/>',
        cross: '<path d="M8 2.4v11.2M2.4 8h11.2"/>',
        watch: '<circle cx="8" cy="8" r="5.4"/><path d="M8 4.9V8l2.2 1.4"/>',
        shield: '<path d="M8 1.7 3.4 3.5v4c0 3 1.8 5.5 4.6 6.8 2.8-1.3 4.6-3.8 4.6-6.8v-4z"/>',
        alert: '<path d="M8 2.2 14 13H2z"/><path d="M8 6.4v3M8 11.3h.01"/>',
        info: '<circle cx="8" cy="8" r="6.2"/><path d="M8 7.3v4.1M8 4.8h.01"/>',
        chevron: '<path d="M4.2 6.4 8 10.2l3.8-3.8"/>',
        pulse: '<path d="M1.6 8.6h2.6l1.4-3.4L8 12.2l1.7-5.1 1.1 1.5h2.6"/>',
        heart: '<path d="M8 13.3C8 13.3 2.4 10.1 2.4 6.4A2.9 2.9 0 0 1 8 5.1a2.9 2.9 0 0 1 5.6 1.3c0 3.7-5.6 6.9-5.6 6.9z"/>',
        moon: '<path d="M12.8 9.6A5.7 5.7 0 0 1 6.2 2a5.7 5.7 0 1 0 6.6 7.6z"/>',
        battery: '<rect x="1.8" y="5" width="10.4" height="6.4" rx="1.8"/><path d="M14.4 7v2.4"/><path d="M5 8h3.4"/>',
        gauge: '<path d="M2.6 11.6a5.4 5.4 0 0 1 10.8 0"/><path d="M8 11.6 10.6 8"/><circle cx="8" cy="11.8" r="0.9" fill="currentColor"/>',
        lungs: '<path d="M8 2.6v5.2"/><path d="M6.6 6.2 4 8.4c-1.1.9-1.4 2.4-.8 3.6.5 1 1.7 1.4 2.7.9L7 12.4c.6-.3 1-.9 1-1.6V6.9"/><path d="M9.4 6.2 12 8.4c1.1.9 1.4 2.4.8 3.6-.5 1-1.7 1.4-2.7.9L9 12.4c-.6-.3-1-.9-1-1.6V6.9"/>',
        calendar: '<rect x="2.2" y="3.4" width="11.6" height="10.4" rx="2"/><path d="M2.2 6.6h11.6M5.4 2.2v2.4M10.6 2.2v2.4"/>',
        chart: '<path d="M2.2 13.4h11.6"/><path d="M4.6 13.4V8.6M8 13.4V3.6M11.4 13.4v-3.2"/>',
        scale: '<path d="M2.4 12.6h11.2"/><path d="M4.4 12.6 6.4 4.2h3.2l2 8.4"/><path d="M8 4.2V2.4"/>',
        sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M12.5 3.5l-1 1M4.5 11.5l-1 1"/>',
        drop: '<path d="M8 2.2c2 2.4 3.4 4.2 3.4 6.1A3.4 3.4 0 0 1 4.6 8.3c0-1.9 1.4-3.7 3.4-6.1z"/>',
        target: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2"/>',
        shoe: '<path d="M1.8 11.6h12.4v1.6H1.8z"/><path d="M2.6 11.6V8.2c0-1 .6-1.9 1.6-2.3l2.3-1 .8 1.5 2.9.6c1.5.3 2.6 1.6 2.6 3.1v1.5"/>'
    };
    function icon(key, cls) {
        return `<svg class="${cls || ""}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[key] || ICONS.info}</svg>`;
    }
    const TYPE_ICON = { tempo: "tempo", interval: "interval", long: "long", easy: "easy", recovery: "easy", cross: "cross", rest: "rest" };
    function iconOf(type) { return TYPE_ICON[type] || "easy"; }
    function toneOf(type) { return (TYPES[type] || TYPES.easy).tone || "easy"; }
    function clampPct(x, floor) {
        if (x == null || !isFinite(x)) return 0;
        return Math.max(floor == null ? 4 : floor, Math.min(100, x * 100));
    }

    // 与基线比：goodWhenHigh=true 表示越高越好（HRV）
    function deltaInfo(val, base, goodWhenHigh) {
        if (val == null || base == null) return null;
        const d = val - base;
        if (Math.abs(d) < 0.5) return { txt: "与基线持平", cls: "" };
        const up = d > 0;
        const good = goodWhenHigh ? up : !up;
        const abs = Math.abs(d) >= 10 ? Math.round(Math.abs(d)) : Math.abs(d).toFixed(1);
        return { txt: (up ? "高于" : "低于") + "基线 " + abs, cls: good ? "good" : "down" };
    }

    // 准备度环
    function ringSvg(score, tone) {
        const R = 53, C = 2 * Math.PI * R;
        const pct = score == null ? 0 : Math.max(0, Math.min(1, score / 10));
        const color = tone === "good" ? "var(--success)" : tone === "ok" ? "var(--warning)"
            : tone === "bad" ? "var(--danger)" : "var(--primary)";
        const label = score == null ? "准备度暂无数据" : `准备度 ${score} 分，满分 10 分`;
        return `<svg viewBox="0 0 128 128" role="img" aria-label="${label}">
            <circle cx="64" cy="64" r="${R}" fill="none" stroke="var(--bg-hover)" stroke-width="9"/>
            <circle cx="64" cy="64" r="${R}" fill="none" stroke="${color}" stroke-width="9"
                stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}"
                stroke-dashoffset="${(C * (1 - pct)).toFixed(1)}" transform="rotate(-90 64 64)"/>
        </svg>`;
    }

    // ACWR 区间条（0–2.0，绿色为安全区 0.8–1.3）
    function acwrGauge(v) {
        const MAX = 2;
        const pos = x => Math.max(0, Math.min(1, x / MAX)) * 100;
        const off = v > 1.3 || v < 0.8;
        const at = (x, txt) => `<span style="position:absolute;left:${pos(x)}%;transform:translateX(-50%)">${txt}</span>`;
        return `<div class="fx-gauge-bar">
            <div class="fx-gauge-track">
                <div class="fx-gauge-safe" style="left:${pos(0.8)}%;width:${pos(1.3) - pos(0.8)}%"></div>
            </div>
            <div class="fx-gauge-mark${off ? " bad" : ""}" style="left:${pos(v)}%">${v.toFixed(2)}</div>
        </div>
        <div class="fx-gauge-scale">
            <span style="position:absolute;left:0">0</span>
            ${at(0.8, "0.8 安全区")}
            ${at(1.3, "1.3")}
            <span style="position:absolute;right:0">2.0</span>
        </div>`;
    }

    // 课表分段（用于今日课表的结构条）
    function segmentsFor(type, km, paceSec, paces) {
        if (!km) return [];
        const p = paces || {};
        const fmt = s => fmtPace(s);
        if (type === "tempo" && km > 4) {
            return [
                { role: "wu", km: 2, label: `热身 2km`, sub: "由慢到快" },
                { role: "main", km: km - 4, label: `主项 ${km - 4}km`, sub: paceSec ? "@ " + fmt(paceSec) : "" },
                { role: "wu", km: 2, label: `放松 2km`, sub: "越跑越慢" }
            ];
        }
        if (type === "interval" && km > 3.2) {
            const reps = Math.max(3, Math.round((km - 4) / 1));
            return [
                { role: "wu", km: 2, label: `热身 2km`, sub: "由慢到快" },
                { role: "main", km: km - 4, label: `${reps}×800m`, sub: (paceSec ? "@ " + fmt(paceSec) : "") + " · 间休 90s" },
                { role: "wu", km: 2, label: `放松 2km`, sub: "越跑越慢" }
            ];
        }
        return [{ role: "main", km, label: (TYPES[type] || TYPES.easy).name + " " + km + "km", sub: paceSec ? "@ " + fmt(paceSec) : "" }];
    }

    function segBarHtml(segs) {
        if (!segs.length) return "";
        const total = segs.reduce((s, x) => s + x.km, 0) || 1;
        const bar = segs.map(s => `<div class="fx-seg-i ${s.role}" style="flex:${(s.km / total).toFixed(3)}"></div>`).join("");
        const legend = segs.map(s =>
            `<span><i class="${s.role}"></i><b>${escapeHtml(s.label)}</b>${s.sub ? " · " + escapeHtml(s.sub) : ""}</span>`
        ).join("");
        return `<div class="fx-seg"><div class="fx-seg-bar">${bar}</div><div class="fx-legend">${legend}</div></div>`;
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

        // 手动标记今日课型
        const mt = els.manualType();
        if (mt) mt.innerHTML = renderManualTypeHtml(data, today);

        // 本周安排
        const wk = els.week();
        if (wk) wk.innerHTML = renderWeekHtml(data, today);

        // 近况
        const st = els.stats();
        if (st) st.innerHTML = renderStatsHtml(data);

        // 未来两周计划
        const pl = els.plan();
        if (pl) pl.innerHTML = renderPlanHtml(data);

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

    // 今天的权威算法结果（由 coach.py 每天算好写入 Supabase）
    function getTodayCoaching(data) {
        const c = data.coaching;
        return (c && c.date === todayStr()) ? c : null;
    }

    function renderTodayHtml(data, today) {
        const m = data.metrics && data.metrics.date === today ? data.metrics : null;
        const coaching = getTodayCoaching(data);
        if (!m) {
            return `<div class="fx-card plain fit-empty">
                <div class="fit-empty-icon">${icon("watch", "fx-empty-ico")}</div>
                <div class="fit-empty-title">还没有今天的身体数据</div>
                <div class="fit-empty-hint">佳明数据由 WorkBuddy 每天早上自动拉取并同步过来。<br>没配的话跟我说一声「配一下佳明」就行。</div>
            </div>`;
        }
        // 优先用 coach.py 的权威结果（coaching），否则本地近似
        const local = computeReadiness(m);
        const score = coaching ? coaching.readiness : local.score;
        const tone = score == null ? "" : (score >= 7.5 ? "good" : score >= 5.5 ? "ok" : "bad");
        const verdictMap = { excellent: "状态极佳", normal: "状态正常", fatigued: "略疲劳", rest: "需要休息" };
        const label = coaching ? (verdictMap[coaching.verdict] || "—")
            : (score == null ? "—" : (score >= 7.5 ? "状态良好" : score >= 6.5 ? "可按计划执行" : score >= 4 ? "建议降量" : "建议休息"));
        const notes = coaching ? (coaching.readinessNotes || []) : local.notes;
        const inputs = coaching ? coaching.readinessInputs : local.inputs;
        const hb = (coaching && coaching.hrv) || null;
        const dTxt = d => d ? `<span class="fx-mtl-d ${d.cls}">${escapeHtml(d.txt)}</span>` : "";

        // 图标化的健康指标卡片（一屏内直接摆开，不用点）
        const tiles = [
            {
                k: "HRV", v: m.hrv, unit: "ms", ic: "pulse", tint: "a",
                d: deltaInfo(m.hrv, (hb && hb.mu) || m.hrvBaseline, true),
                pct: clampPct(m.hrv / ((hb && hb.bandHigh) || m.hrvBandHigh || (m.hrvBaseline ? m.hrvBaseline * 1.2 : 150)))
            },
            {
                k: "静息心率", v: m.rhr, unit: "bpm", ic: "heart", tint: "b",
                d: deltaInfo(m.rhr, m.rhrBaseline, false),
                pct: clampPct(m.rhr && m.rhrBaseline ? m.rhr / (m.rhrBaseline * 1.4) : null)
            },
            {
                k: "睡眠", v: m.sleepScore != null ? m.sleepScore : m.sleepHours, unit: m.sleepScore != null ? "分" : "h",
                ic: "moon", tint: "c",
                d: (m.sleepHours != null && m.sleepScore != null) ? { txt: m.sleepHours + " 小时", cls: "" } : null,
                pct: clampPct(m.sleepScore != null ? m.sleepScore / 100 : (m.sleepHours ? m.sleepHours / 9 : null))
            },
            {
                k: "身体电量", v: m.bodyBattery, unit: "", ic: "battery", tint: "d",
                d: m.bodyBattery != null ? { txt: m.bodyBattery < 40 ? "偏低" : "正常", cls: m.bodyBattery < 40 ? "down" : "good" } : null,
                pct: clampPct(m.bodyBattery != null ? m.bodyBattery / 100 : null)
            },
            {
                k: "压力", v: m.stress, unit: "", ic: "gauge", tint: "e",
                d: m.stress != null ? { txt: m.stress > 50 ? "偏高" : "放松", cls: m.stress > 50 ? "down" : "good" } : null,
                pct: clampPct(m.stress != null ? m.stress / 100 : null)
            },
            {
                k: "VO2max", v: m.vo2max, unit: "", ic: "lungs", tint: "f",
                d: m.vo2maxDate ? { txt: m.vo2maxDate.slice(5).replace("-", "/") + " 测", cls: "" } : null,
                pct: clampPct(m.vo2max != null ? m.vo2max / 60 : null)
            },
            {
                k: "佳明准备度", v: m.garminReadiness, unit: "",
                ic: "target", tint: "g",
                d: m.garminReadinessLevel ? { txt: m.garminReadinessLevel, cls: "" } : null,
                pct: clampPct(m.garminReadiness != null ? m.garminReadiness / 100 : null)
            },
            {
                k: "天气", v: m.weather ? Math.round(m.weather.temp) : null, unit: "℃",
                ic: m.weather && m.weather.dewPoint >= 21 ? "drop" : "sun", tint: "h",
                d: m.weather ? { txt: `露点 ${Math.round(m.weather.dewPoint)}° 湿度 ${Math.round(m.weather.humidity)}%`, cls: m.weather.dewPoint >= 21 ? "down" : "" } : null,
                pct: m.weather ? clampPct(m.weather.humidity / 100) : null
            }
        ].filter(t => t.v != null || t.k === "天气");

        return `<div class="fx-card plain">
            <div class="fx-head">
                <span class="fx-head-ico fx-tint-g">${icon("pulse")}</span>
                <h3>训练状态</h3>
                <span class="fx-head-sub">佳明今晨数据</span>
                ${coaching && coaching.weeksOut != null
                    ? `<span class="fx-head-right">${escapeHtml(phaseName(coaching.phase))} · 距比赛 ${Math.round(coaching.weeksOut)} 周</span>`
                    : ""}
            </div>
            <div class="fx-statusbar">
                <div class="fx-ring sm">
                    ${ringSvg(score, tone)}
                    <div class="fx-ring-mid">
                        <span class="fx-ring-num">${score != null ? score : "—"}</span>
                        <span class="fx-ring-max">/ 10</span>
                    </div>
                </div>
                <div class="fx-statusbar-txt">
                    <div class="fx-statusbar-label">${escapeHtml(label)}${inputs ? `<span> · ${inputs} 项数据综合</span>` : ""}</div>
                    ${notes.length ? `<div class="fx-notes">${notes.map(n => `<div class="fx-note">${escapeHtml(n)}</div>`).join("")}</div>` : ""}
                </div>
            </div>
            <div class="fx-mtiles">
                ${tiles.map(t => `<div class="fx-mtl fx-tint-${t.tint}">
                    <span class="fx-mtl-ico">${icon(t.ic)}</span>
                    <div class="fx-mtl-txt">
                        <div class="fx-mtl-v">${t.v != null ? t.v : "—"}${t.unit ? `<small>${t.unit}</small>` : ""}</div>
                        <div class="fx-mtl-k">${escapeHtml(t.k)}</div>
                        ${dTxt(t.d)}
                    </div>
                    <div class="fx-mtl-track"><i style="width:${t.pct}%"></i></div>
                </div>`).join("")}
            </div>
        </div>`;
    }

    function renderWorkoutHtml(data, today) {
        const s = suggestWorkout(data);
        const T = TYPES[s.type] || TYPES.easy;
        const advice = data.advice && data.advice.date === today ? data.advice : null;
        const coaching = getTodayCoaching(data);

        // 优先：coach.py 的权威课表 → 其次：WorkBuddy 写的 advice → 最后：本地兜底
        let w, tone, type, name, km, pace, flags, detailText, isFallback;
        if (coaching && coaching.session) {
            const cs = coaching.session;
            const CT = TYPES[cs.type] || TYPES.easy;
            w = cs; tone = cs.tone || CT.tone; type = cs.type;
            name = cs.name || CT.name; km = cs.km; pace = cs.pace;
            flags = coaching.flags || [];
            detailText = cs.detail || "";
            isFallback = false;
        } else if (advice) {
            w = advice.workout || {};
            tone = w.tone || T.tone; type = w.type || s.type;
            name = advice.headline || w.name || T.name; km = w.km || s.km; pace = w.pace || s.pace;
            flags = (w && Array.isArray(w.flags)) ? w.flags : [];
            detailText = advice.detail || "";
            isFallback = false;
        } else {
            w = {}; tone = T.tone; type = s.type;
            name = s.headline || T.name; km = s.km; pace = s.pace;
            flags = (s.overload && s.load) ? [`负荷比 ${s.load.ratio.toFixed(2)} 超出安全区 0.8-1.3`] : [];
            detailText = s.detail || "";
            isFallback = true;
        }

        const paceSec = typeof pace === "number" ? pace : null;
        const paces = (data.coaching && data.coaching.paces) || pacesFromGoal(data.goal);
        const isRest = type === "rest" || !km;
        const segs = isRest ? [] : segmentsFor(type, km, paceSec, paces);
        // 旗标分类：闸门（触发式降级）/ 负荷提醒 / 其他说明
        const flagItems = (flags || []).map(f => {
            if (/闸门/.test(f)) {
                return { cls: "", ic: "shield", title: "闸门", text: String(f).replace(/^守闸门[:：]\s*/, "") };
            }
            if (/ACWR|负荷|安全区/.test(f)) {
                return { cls: " warn", ic: "alert", title: "负荷提醒", text: String(f) };
            }
            return { cls: "", ic: "info", title: "说明", text: String(f).replace(/^[^：:]{0,14}[:：]\s*/, "") };
        });
        const goal = data.goal || {};
        const dLeft = goal.raceDate ? daysUntil(goal.raceDate) : null;
        const phaseTxt = (coaching && coaching.phase) ? phaseName(coaching.phase) : "";

        return `<div class="fx-card plain fx-tone-${tone}">
            <div class="fx-hero-top">
                <span class="fx-badge">${icon(iconOf(type))} ${escapeHtml(name || T.name)}</span>
                <span class="fx-pill">${dLeft != null ? `距比赛 <b>${dLeft}</b> 天` : "未设目标"}${phaseTxt ? ` · ${escapeHtml(phaseTxt)}` : ""}</span>
            </div>
            <div class="fx-hero-main">
                ${isRest ? `<div class="fx-km rest-num">休息日</div>` : `<div class="fx-km">${km}<small>km</small></div>`}
                ${!isRest && pace ? `<div class="fx-pace">${typeof pace === "number" ? fmtPace(pace) : escapeHtml(String(pace))}<small>/km</small></div>` : ""}
                <div class="fx-hero-side">
                    ${paceSec && paces && paces.easy ? `热身与放松锚在轻松跑配速 <b>${fmtPace(paces.easy)}</b>` : ""}
                </div>
            </div>
            ${segBarHtml(segs)}
            <div class="fx-detail">${escapeHtml(detailText).replace(/\n/g, "<br>")}</div>
            ${flagItems.map(f => `<div class="fx-gate${f.cls}">${icon(f.ic)}<div><b>${f.title}</b> · ${escapeHtml(f.text)}</div></div>`).join("")}
            ${isFallback ? `<div class="fx-src">本地规则估算（今天的 coach 结果还没出来）</div>` : ""}
            ${isRest ? "" : `<div class="fx-actions">
                <button class="fx-btn primary fit-plan-push" data-date="${today}" type="button">${icon("watch")} 推到佳明手表</button>
            </div>`}
        </div>`;
    }

    function renderManualTypeHtml(data, today) {
        const cur = (data.manualTypes && data.manualTypes[today]) || null;
        const btns = MANUAL_TYPES.map(t =>
            `<button class="fx-chipbtn${cur === t.key ? " on" : ""}" data-type="${t.key}" type="button">${t.name}</button>`
        ).join("");
        return `<div class="fx-manual">
            <span class="fx-manual-label">跑完点一下实际课型 · 算法按真实课型算负荷</span>
            ${btns}
            ${cur ? `<span class="fx-manual-label">已标记（再点一次取消）</span>` : ""}
        </div>`;
    }

    function markManualType(type) {
        const data = load();
        if (!data.manualTypes) data.manualTypes = {};
        const today = todayStr();
        if (data.manualTypes[today] === type) {
            delete data.manualTypes[today];
        } else {
            data.manualTypes[today] = type;
        }
        save(data);
        render();
        Api.showToast(data.manualTypes[today] ? "已标记今日课型 ✓" : "已取消标记", "success");
    }

    // 本周每天：实际跑量（logs 当天可能有多次，需累加）优先，没有就用计划量
    function weekVolume(data, today) {
        const plan = (data.coaching && data.coaching.plan) || data.plan || [];
        const logs = data.logs || [];
        const t0 = parseDate(today) || new Date();
        const monday = new Date(t0.getTime());
        monday.setDate(t0.getDate() - ((t0.getDay() + 6) % 7));
        monday.setHours(0, 0, 0, 0);
        const bars = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(monday.getTime());
            d.setDate(monday.getDate() + i);
            const ds = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
            const pi = plan.find(p => p.date === ds) || null;
            const dayLogs = logs.filter(l => l.date === ds);
            const actual = Math.round(dayLogs.reduce((s, l) => s + (Number(l.km) || 0), 0) * 100) / 100;
            bars.push({
                date: ds, wd: d.getDay(),
                actual, runs: dayLogs.length,
                plan: pi ? Number(pi.km) || 0 : 0,
                type: (pi && pi.type) || "rest",
                done: actual > 0, isToday: ds === today
            });
        }
        return bars;
    }

    function renderWeekHtml(data, today) {
        const bars = weekVolume(data, today);
        const max = Math.max(4, Math.max.apply(null, bars.map(b => Math.max(b.plan, b.actual))));
        const cols = bars.map(b => {
            const km = b.done ? b.actual : b.plan;
            const h = km ? Math.max(6, Math.round((km / max) * 100)) : 2;
            return `<div class="fx-bar-col ${b.isToday ? "is-today" : ""}" title="${b.date} · ${km ? km + " km" : "休息"}">
                <div class="fx-bar-slot">
                    <div class="fx-bar-stack" style="height:${h}%">
                        ${km ? `<span class="fx-bar-val">${km}</span>` : ""}
                        <div class="fx-bar fx-tone-${toneOf(b.type)}${b.done ? " done" : ""}${km ? "" : " idle"}"></div>
                    </div>
                </div>
                <div class="fx-bar-w">${WEEK_NAMES[b.wd]}</div>
            </div>`;
        }).join("");
        const doneKm = Math.round(bars.reduce((s, b) => s + b.actual, 0) * 10) / 10;
        const planKm = Math.round(bars.reduce((s, b) => s + b.plan, 0) * 10) / 10;
        const doneCount = bars.reduce((s, b) => s + b.runs, 0);
        const quality = bars.filter(b => ["tempo", "interval", "long"].includes(b.type)).length;
        const td = Array.isArray(data.trainingDays) ? data.trainingDays : [];
        const showRate = planKm > doneKm && planKm > 0;
        const md = ds => {
            const d = parseDate(ds);
            return d ? `${d.getMonth() + 1}/${d.getDate()}` : ds;
        };
        return `<div class="fx-card">
            <div class="fx-head">
                <span class="fx-head-ico fx-tint-c">${icon("chart")}</span>
                <h3>本周训练量</h3>
                <span class="fx-head-sub">实心=已完成，浅色=计划</span>
                <span class="fx-head-right">${md(bars[0].date)} – ${md(bars[6].date)}</span>
            </div>
            <div class="fx-chart"><div class="fx-bars">${cols}</div></div>
            <div class="fx-chart-foot">
                <span>已完成 <b>${doneKm} km</b></span>
                <span>跑了 <b>${doneCount}</b> 次</span>
                <span>质量课 <b>${quality} 场</b></span>
                ${showRate ? `<span>完成率 <b>${Math.round(doneKm / planKm * 100)}%</b></span>` : ""}
            </div>
            ${td.length ? "" : `<div class="fx-week-hint">还没选训练日 · <a href="#" id="fitWeekGoto">去设置</a></div>`}
        </div>`;
    }

    function renderStatsHtml(data) {
        const m = data.metrics || null;
        const coaching = getTodayCoaching(data);
        const lr = loadRatio(data.logs || []);
        const load = (coaching && coaching.load) || null;
        const acwr = (load && load.acwr != null) ? load.acwr : (lr && lr.ratio != null ? lr.ratio : null);
        const km7 = (m && m.last7Km != null) ? m.last7Km : countKm(data.logs, 7);
        const km28 = (m && m.last28Km != null) ? m.last28Km : countKm(data.logs, 28);
        if (acwr == null) {
            return `<div class="fx-card">
                <div class="fx-head"><h3>负荷平衡</h3></div>
                <div class="fx-gauge-legend">还没有足够数据算负荷比（需要近 28 天的跑量记录）。</div>
                <div class="fx-load-row">
                    <div class="fx-load-item"><span>近 7 天跑量</span><b>${km7}<small>km</small></b></div>
                    <div class="fx-load-item"><span>近 28 天跑量</span><b>${km28}<small>km</small></b></div>
                </div>
            </div>`;
        }
        const acute = load ? (Number(load.atlRun || 0) + Number(load.atlStr || 0)) : null;
        const chronic = load ? load.ctlTotal : null;
        const tsb = load ? load.tsb : null;
        const zone = acwr < 0.8 ? "量偏少" : acwr <= 1.3 ? "安全区" : acwr <= 1.5 ? "偏高" : "高危";
        const tsbTxt = tsb == null ? "—" : (tsb > 5 ? "状态新鲜" : tsb >= -10 ? "正常" : tsb >= -30 ? "疲劳累积" : "过度疲劳");
        const fmt1 = x => (x == null || !isFinite(x)) ? "—" : (Math.round(x * 10) / 10).toFixed(1);

        return `<div class="fx-card">
            <div class="fx-head">
                <span class="fx-head-ico fx-tint-e">${icon("scale")}</span>
                <h3>负荷平衡</h3>
                <span class="fx-head-sub">急性负荷(7天) ÷ 慢性负荷(28天)</span>
                <span class="fx-head-right">当前 ${zone}</span>
            </div>
            ${acwrGauge(acwr)}
            <div class="fx-load-row">
                <div class="fx-load-item"><span>急性负荷</span><b>${fmt1(acute)}<small>7天</small></b></div>
                <div class="fx-load-item"><span>慢性负荷</span><b>${fmt1(chronic)}<small>28天</small></b></div>
                <div class="fx-load-item"><span>疲劳平衡 TSB</span><b>${fmt1(tsb)}<small>${tsbTxt}</small></b></div>
                <div class="fx-load-item"><span>近 7 天跑量</span><b>${km7}<small>km</small></b></div>
                <div class="fx-load-item"><span>近 28 天跑量</span><b>${km28}<small>km</small></b></div>
            </div>
            <div class="fx-gauge-legend" style="margin-top:12px">安全区 0.8–1.3；高于 1.5 属高危，需要减量或休息。</div>
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

    /* ---------- 未来 N 天计划 ---------- */
    function pad2(n) { return String(n).padStart(2, "0"); }

    // 某天是本周第几个训练日（0 起），用于分配课表类型（保持每周轮换）
    function trainingSlotFor(date, td) {
        const wd = date.getDay();
        const monday = new Date(date);
        monday.setDate(date.getDate() - ((wd + 6) % 7));
        monday.setHours(0, 0, 0, 0);
        let slot = -1;
        for (let j = 0; j < 7; j++) {
            const c = new Date(monday); c.setDate(monday.getDate() + j);
            if (c > date) break;
            if (td.includes(c.getDay())) slot++;
        }
        return Math.max(slot, 0);
    }

    function generatePlan(data, days) {
        const goal = data.goal || null;
        const paces = pacesFromGoal(goal);
        const weeksOut = goal && goal.raceDate ? (daysUntil(goal.raceDate) != null ? daysUntil(goal.raceDate) / 7 : null) : null;
        const phase = planPhase(weeksOut);
        const td = Array.isArray(data.trainingDays) ? data.trainingDays.slice().sort((a, b) => a - b) : [];
        const lr = loadRatio(data.logs);
        const totalSlots = Math.max(td.length, 1);
        const plan = [];
        const today = new Date(); today.setHours(0, 0, 0, 0);
        for (let i = 0; i < days; i++) {
            const d = new Date(today); d.setDate(today.getDate() + i);
            const dateStr = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
            const wd = d.getDay();
            if (!td.includes(wd)) {
                plan.push({ date: dateStr, wd, type: "rest", name: "休息", km: 0, paceSec: null, pace: null, detail: "休息日。散步 20-30 分钟、拉伸或核心力量都行。" });
                continue;
            }
            const slot = trainingSlotFor(d, td) % totalSlots;
            const type = sessionForSlot(slot, phase, null, totalSlots);
            const w = buildSession(type, paces, weeksOut, phase, null, lr);
            plan.push({
                date: dateStr, wd, type, name: TYPES[type].name,
                km: w.km || 0,
                paceSec: (typeof w.pace === "number") ? w.pace : null,
                pace: (typeof w.pace === "number") ? fmtPace(w.pace) : null,
                detail: w.detail
            });
        }
        return plan;
    }

    function renderPlanHtml(data) {
        // 优先用云端的 14 天计划（coach.py 跑出的，遵守 claude-fitness-cn 周期化逻辑），
        // 失败才退回旧的本地 generatePlan
        const cloudPlan = (data.coaching && data.coaching.plan) || data.plan;
        const plan = (Array.isArray(cloudPlan) && cloudPlan.length)
            ? cloudPlan
            : generatePlan(data, 14);
        const t = todayStr();
        // 今天这一行用 coach 的权威结果（已考虑准备度 + ACWR），否则退回 suggestWorkout
        const coaching = getTodayCoaching(data);
        const todaySuggested = suggestWorkout(data);

        const rows = plan.map(p => {
            let item;
            if (p.date === t) {
                if (coaching && coaching.session) {
                    item = {
                        type: coaching.session.type,
                        name: coaching.session.name,
                        km: coaching.session.km || 0,
                        pace: coaching.session.pace != null ? fmtPace(coaching.session.pace) : null,
                        detail: coaching.session.detail || p.detail
                    };
                } else {
                    item = {
                        type: todaySuggested.type,
                        name: todaySuggested.headline,
                        km: todaySuggested.km || 0,
                        pace: typeof todaySuggested.pace === "number" ? fmtPace(todaySuggested.pace) : (todaySuggested.pace || null),
                        detail: todaySuggested.detail || p.detail
                    };
                }
            } else {
                item = {
                    type: p.type,
                    name: p.name || (TYPES[p.type] || {}).name || p.type,
                    km: p.km || 0,
                    // 云端 plan 的 pace 是「秒/公里」数字，本地 generatePlan 已是格式化字符串
                    pace: p.pace != null ? (typeof p.pace === "number" ? fmtPace(p.pace) : p.pace) : null,
                    detail: p.detail || ""
                };
            }
            const dObj = parseDate(p.date);
            const flags = (p.flags && p.flags.length) ? p.flags.slice()
                : (item.overload ? ["负荷比超出安全区 0.8-1.3"] : []);
            return {
                date: p.date,
                type: item.type,
                name: item.name || (TYPES[item.type] || TYPES.easy).name,
                km: Number(item.km) || 0,
                pace: item.pace,
                detail: item.detail || "",
                flags,
                gate: flags.some(f => /闸门/.test(f)),
                isToday: p.date === t,
                label: dObj ? `${dObj.getMonth() + 1}/${dObj.getDate()} 周${WEEK_NAMES[p.wd]}` : p.date
            };
        });

        // 按自然周分组（周一起），周头显示该周总量
        const groups = [];
        const mondayKey = d => {
            const m = new Date(d.getTime());
            m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
            return m;
        };
        const tMon = mondayKey(parseDate(t) || new Date());
        rows.forEach(r => {
            const d = parseDate(r.date) || new Date();
            const mon = mondayKey(d);
            const key = mon.getFullYear() + "-" + pad2(mon.getMonth() + 1) + "-" + pad2(mon.getDate());
            let g = groups.find(x => x.key === key);
            if (!g) {
                const sun = new Date(mon.getTime()); sun.setDate(mon.getDate() + 6);
                g = {
                    key,
                    title: `${mon.getMonth() + 1}/${mon.getDate()} – ${sun.getMonth() + 1}/${sun.getDate()}`,
                    isThis: mon.getTime() === tMon.getTime(),
                    items: []
                };
                groups.push(g);
            }
            g.items.push(r);
        });

        const html = groups.map(g => {
            const km = Math.round(g.items.reduce((s, x) => s + x.km, 0) * 10) / 10;
            const q = g.items.filter(x => ["tempo", "interval", "long"].includes(x.type)).length;
            const list = g.items.map(r => `<div class="fx-day fx-tone-${toneOf(r.type)}${r.isToday ? " today" : ""}" data-date="${r.date}">
                <div class="fx-day-row">
                    <span class="fx-day-date">${r.label}${r.isToday ? ' <b>今天</b>' : ""}</span>
                    <span class="fx-day-dot${r.type === "rest" ? " off" : ""}"></span>
                    <span class="fx-day-type">${icon(iconOf(r.type))} ${escapeHtml(r.name)}</span>
                    <span class="fx-day-meta">${r.type === "rest" ? "休息" : `<b>${r.km}</b> km${r.pace ? " · " + r.pace + "/km" : ""}`}</span>
                    ${r.gate ? `<span class="fx-chip gate">闸门</span>` : ""}
                    <span class="fx-day-caret">${icon("chevron")}</span>
                </div>
                <div class="fx-day-detail hidden">
                    <div>${escapeHtml(r.detail).replace(/\n/g, "<br>")}</div>
                    ${r.flags.length ? `<div class="fx-chip-row">${r.flags.map(f =>
                        `<span class="fx-chip${/闸门/.test(f) ? " gate" : ""}">${escapeHtml(String(f).replace(/^守闸门[:：]\s*/, "闸门 · "))}</span>`).join("")}</div>` : ""}
                    ${r.type !== "rest" ? `<div class="fx-detail-actions"><button class="fx-btn fit-plan-push" data-date="${r.date}" type="button">${icon("watch")} 推到佳明手表</button></div>` : ""}
                </div>
            </div>`).join("");
            return `<div class="fx-week"><b>${g.title}</b>${g.isThis ? " · 本周" : ""}<span class="fx-week-total">合计 <b>${km} km</b> · 质量课 ${q} 场</span></div>${list}`;
        }).join("");

        const source = (Array.isArray(cloudPlan) && cloudPlan.length) ? "coach.py 算法" : "本地估算";
        const totalKm = Math.round(rows.reduce((s, r) => s + r.km, 0) * 10) / 10;
        const quality = rows.filter(r => ["tempo", "interval", "long"].includes(r.type)).length;
        const restDays = rows.filter(r => r.type === "rest").length;
        const mini = rows.map(r => `<i class="fx-tone-${toneOf(r.type)}${r.isToday ? " now" : ""}${r.km ? "" : " idle"}"
            title="${r.label} · ${r.km ? r.km + " km" : "休息"}"></i>`).join("");
        const open = isPlanOpen();
        return `<div class="fx-card fx-fold${open ? " open" : ""}" id="fxPlanFold">
            <div class="fx-fold-head" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}">
                <span class="fx-fold-ico">${icon("calendar")}</span>
                <div class="fx-fold-txt">
                    <b>训练计划</b>
                    <span>未来两周 ${rows.length} 天 · 合计 <em>${totalKm} km</em> · 质量课 ${quality} 场 · 休息 ${restDays} 天</span>
                </div>
                <span class="fx-fold-caret">${icon("chevron")}</span>
            </div>
            <div class="fx-fold-mini">${mini}</div>
            <div class="fx-fold-body${open ? "" : " hidden"}">
                <div class="fx-fold-note">${source} · 点开某天看分段配速，可推到手表</div>
                <div class="fx-plan">${html}</div>
            </div>
        </div>`;
    }

    // 训练计划面板的开合状态（记住用户的选择，默认收起）
    function isPlanOpen() {
        try { return localStorage.getItem("dw_fit_plan_open") === "1"; }
        catch (e) { return false; }
    }

    // 推送到佳明：写 pushWorkout 请求，由守护进程调 push_workout.py 上传
    async function requestPushWorkout(dateStr) {
        const data = load();
        // 优先用云端 plan（含正确配速），退回本地 generatePlan
        const cloudPlan = (data.coaching && data.coaching.plan) || data.plan;
        const plan = (Array.isArray(cloudPlan) && cloudPlan.length) ? cloudPlan : generatePlan(data, 14);
        const item = plan.find(p => p.date === dateStr);
        if (!item || item.type === "rest") { Api.showToast("休息日没有可推的课表", ""); return; }
        // 云端 plan 用 pace（秒/公里），本地用 paceSec，统一取秒数
        const paceSec = item.pace != null ? item.pace : item.paceSec;
        if (!paceSec || !item.km) { Api.showToast("这条课表没有配速/距离，先去设置目标成绩", "error"); return; }
        data.pushWorkout = {
            date: dateStr, name: item.name, type: item.type,
            km: item.km, paceSec: Math.round(paceSec), detail: item.detail,
            requestedAt: Date.now(), status: "pending"
        };
        save(data);
        // 写云端
        const c = supabaseClient();
        if (c) {
            try {
                const syncId = (window.APP_CONFIG.supabase.syncId || "main");
                const { data: rows } = await c.from("sync_data").select("payload").eq("id", syncId).maybeSingle();
                const payload = (rows && rows.payload) || {};
                const fit = payload.fitness || {};
                fit.pushWorkout = data.pushWorkout;
                payload.fitness = fit;
                await c.from("sync_data").upsert({ id: syncId, payload, updated_at: new Date().toISOString() });
                Api.showToast("已提交，稍后会推到你佳明的训练计划里（去手表/App 同步后即可跟着练）", "success");
                return;
            } catch (e) {
                console.error("pushWorkout 写云端失败:", e);
                Api.showToast("写云端失败：" + (e.message || "网络问题") + "，可让我直接推", "error");
                return;
            }
        }
        Api.showToast("已记录到本地，但云端同步未开启，守护进程收不到", "error");
    }

    // 绑定挂在整张卡片上：计划行的展开、训练计划面板的开合、今日课表的推送按钮都能命中
    function bindPlanEvents() {
        const box = document.getElementById("fitnessCard") || els.plan();
        if (!box || box._bound) return;
        box._bound = true;
        const toggleFold = head => {
            const fold = head.closest(".fx-fold");
            const body = fold && fold.querySelector(".fx-fold-body");
            if (!body) return;
            const willOpen = body.classList.contains("hidden");
            body.classList.toggle("hidden", !willOpen);
            fold.classList.toggle("open", willOpen);
            head.setAttribute("aria-expanded", willOpen ? "true" : "false");
            try { localStorage.setItem("dw_fit_plan_open", willOpen ? "1" : "0"); } catch (e) { }
        };
        box.addEventListener("click", e => {
            const foldHead = e.target.closest(".fx-fold-head");
            if (foldHead) { toggleFold(foldHead); return; }
            const pushBtn = e.target.closest(".fit-plan-push");
            if (pushBtn) { e.stopPropagation(); requestPushWorkout(pushBtn.dataset.date); return; }
            const row = e.target.closest(".fx-day-row") || e.target.closest(".fit-plan-row");
            if (!row) return;
            const day = row.closest(".fx-day") || row.closest(".fit-plan-day");
            if (!day) return;
            const detail = day.querySelector(".fx-day-detail") || day.querySelector(".fit-plan-detail");
            if (detail) {
                detail.classList.toggle("hidden");
                day.classList.toggle("open", !detail.classList.contains("hidden"));
            }
        });
        // 键盘也能开合训练计划
        box.addEventListener("keydown", e => {
            const foldHead = e.target.closest(".fx-fold-head");
            if (foldHead && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                toggleFold(foldHead);
            }
        });
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
        // 关键：直接写云端，绕过 CloudSync 的合并（之前 null 覆盖 / 竞态导致目标被抹掉）
        writeGoalToCloud(data.goal, days);
        els.settings().classList.add("hidden");
        render();
        Api.showToast("目标已保存，下次生成建议会按新目标来", "success");
    }

    // 把目标/训练日直接写进 Supabase（读-改-写，与 markSyncRequest 同一套路）
    async function writeGoalToCloud(goal, trainingDays) {
        const c = supabaseClient();
        if (!c) return;
        try {
            const syncId = (window.APP_CONFIG.supabase.syncId || "main");
            const { data: rows } = await c.from("sync_data")
                .select("payload").eq("id", syncId).maybeSingle();
            const payload = (rows && rows.payload) || {};
            const fit = payload.fitness || {};
            fit.goal = goal;
            fit.trainingDays = trainingDays;
            payload.fitness = fit;
            const { error } = await c.from("sync_data").upsert({
                id: syncId, payload, updated_at: new Date().toISOString()
            });
            if (error) console.warn("writeGoalToCloud error", error);
            else console.log("[fitness] 目标已直写云端");
        } catch (e) {
            console.warn("writeGoalToCloud failed", e);
        }
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

    /* ================= 直连 Supabase 读 fitness =================
       页面展示不再只依赖 CloudSync 的本地缓存 + Realtime（Realtime 没开时页面不会自动刷新），
       这里直接用 supabase client 读云端 fitness，保证"打开/点同步后一定能看到最新数据"。 */
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function supabaseClient() {
        const cfg = window.APP_CONFIG && window.APP_CONFIG.supabase;
        if (!cfg || !cfg.enabled || !cfg.url || !window.supabase) return null;
        return window.supabase.createClient(cfg.url, cfg.anonKey);
    }

    async function fetchCloudFitness() {
        const c = supabaseClient();
        if (!c) return null;
        try {
            const syncId = (window.APP_CONFIG.supabase.syncId || "main");
            const { data, error } = await c.from("sync_data")
                .select("payload").eq("id", syncId).maybeSingle();
            if (error || !data || !data.payload) return null;
            return data.payload.fitness || null;
        } catch (e) { return null; }
    }

    // 用云端 fitness 覆盖本地并重渲染；返回是否有变化
    async function refreshFromCloud() {
        const cloud = await fetchCloudFitness();
        if (!cloud) return false;
        const local = load();
        const merged = mergeCloudOverLocal(local, cloud);
        Api.store.set(KEY, merged);
        render();
        return true;
    }

    // 云端覆盖本地，但跳过 null/undefined（避免云端历史 null 把用户刚设的目标/训练日抹掉）
    function mergeCloudOverLocal(local, cloud) {
        const out = { ...(local || {}) };
        Object.keys(cloud || {}).forEach(k => {
            if (cloud[k] != null) out[k] = cloud[k];
        });
        return out;
    }

    /* ================= 同步佳明 =================
       页面不能直连佳明（佳明 token 在本机），所以"点一下同步"：
       1. 往 Supabase 写 syncRequest=pending
       2. 本机守护进程每 30s 巡一次，发现 pending 就拉数据写回（并标 done）
       3. 本页轮询云端，等 done 或 metrics 变化后自动刷新显示 */
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
        const showHint = (msg) => {
            const h = els.syncHint();
            if (!h) return;
            h.textContent = msg;
            h.classList.remove("hidden");
        };
        btn.disabled = true; btn.textContent = "同步中…";
        showHint("已请求同步 · 通常 30 秒内到位");

        const r = await markSyncRequest();
        if (!r.ok) {
            btn.disabled = false; btn.textContent = orig;
            showHint("请求失败：" + (r.reason || "网络问题"));
            Api.showToast("同步请求失败，建议直接说「同步一下佳明」", "error");
            return;
        }

        // 轮询云端，等守护进程把最新数据写回（最多 100 秒）
        let synced = false;
        for (let i = 0; i < 20; i++) {
            await sleep(5000);
            const cloud = await fetchCloudFitness();
            if (!cloud) continue;
            const local = load();
            Api.store.set(KEY, mergeCloudOverLocal(local, cloud));
            render();
            const sr = cloud.syncRequest;
            const metricsChanged = cloud.metrics && (!local.metrics || cloud.metrics.updatedAt !== local.metrics.updatedAt);
            if ((sr && sr.status === "done") || metricsChanged) {
                synced = true;
                break;
            }
        }

        btn.disabled = false; btn.textContent = orig;
        if (synced) {
            showHint("✓ 已同步最新数据");
            Api.showToast("佳明数据已更新 ✨", "success");
        } else {
            showHint("暂时没拉到新数据 · 可稍后再点一次，或直接刷新页面");
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
                const wasHidden = box.classList.contains("hidden");
                box.classList.toggle("hidden");
                // 设置面板在卡片最底部（14 天计划下面），打开时滚到可视区，否则用户以为没反应
                if (wasHidden) {
                    box.scrollIntoView({ behavior: "smooth", block: "center" });
                }
            });
        }
        const mtBox = els.manualType();
        if (mtBox && !mtBox._bound) {
            mtBox._bound = true;
            mtBox.addEventListener("click", e => {
                const b = e.target.closest(".fit-mtype-btn");
                if (b) markManualType(b.dataset.type);
            });
        }
    }

    /* ================= 初始化 ================= */
    function init() {
        render();
        bindPlanEvents();
        // 打开页面就从云端拉一次 fitness，确保显示最新（不依赖 CloudSync 的 Realtime）
        refreshFromCloud();
        document.addEventListener("dw:dataChanged", e => {
            if (e.detail && e.detail.key === KEY) render();
        });
        document.addEventListener("dw:remoteSynced", render);
    }

    function refresh() { render(); refreshFromCloud(); }

    return { init, refresh, load, save, suggestWorkout, computeReadiness, pacesFromGoal };
})();
