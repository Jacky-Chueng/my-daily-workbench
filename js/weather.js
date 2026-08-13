/* =====================================================================
   weather.js — 今日天气模块
   ---------------------------------------------------------------------
   使用 wttr.in 免费天气服务（无需 API Key，支持 CORS）。
   - 展示城市、温度、天气描述（中文）、图标、体感/湿度/风速/风向/能见度/气压
   - 城市由用户自行添加 / 删除 / 改名（仅存 localStorage，无预设城市）
   - 当前选中城市记忆到 localStorage
   - 查询带超时与失败重试，避免代理不稳时界面卡死
   - 获取失败时展示友好提示
   ===================================================================== */

const Weather = (() => {
    const CITIES_KEY = "dw_weather_cities";   // 用户自定义城市列表 [{id, name}]
    const CITY_KEY = "dw_weather_city";       // 当前选中城市 id
    const FETCH_TIMEOUT = 9000;               // 直连超时
    const PROXY_TIMEOUT = 12000;              // 代理重试超时

    /* ---------- weatherCode → 中文描述 + emoji ---------- */
    const CODE_MAP = {
        113: { zh: "晴", emoji: "☀️" },
        116: { zh: "局部多云", emoji: "⛅" },
        119: { zh: "多云", emoji: "☁️" },
        122: { zh: "阴", emoji: "☁️" },
        143: { zh: "薄雾", emoji: "🌫️" },
        176: { zh: "小雨", emoji: "🌦️" },
        179: { zh: "小雪", emoji: "🌨️" },
        182: { zh: "雨夹雪", emoji: "🌨️" },
        185: { zh: "雨夹雪", emoji: "🌨️" },
        200: { zh: "雷阵雨", emoji: "⛈️" },
        227: { zh: "小雪", emoji: "🌨️" },
        230: { zh: "暴雪", emoji: "❄️" },
        248: { zh: "雾", emoji: "🌫️" },
        260: { zh: "雾", emoji: "🌫️" },
        263: { zh: "毛毛雨", emoji: "🌦️" },
        266: { zh: "小雨", emoji: "🌦️" },
        281: { zh: "冻雨", emoji: "🌧️" },
        284: { zh: "冻雨", emoji: "🌧️" },
        293: { zh: "小雨", emoji: "🌦️" },
        296: { zh: "小雨", emoji: "🌦️" },
        299: { zh: "中雨", emoji: "🌧️" },
        302: { zh: "中雨", emoji: "🌧️" },
        305: { zh: "大雨", emoji: "🌧️" },
        308: { zh: "大雨", emoji: "🌧️" },
        311: { zh: "暴雨", emoji: "🌧️" },
        314: { zh: "暴雨", emoji: "🌧️" },
        317: { zh: "雨夹雪", emoji: "🌨️" },
        320: { zh: "雨夹雪", emoji: "🌨️" },
        323: { zh: "小雪", emoji: "🌨️" },
        326: { zh: "小雪", emoji: "🌨️" },
        329: { zh: "中雪", emoji: "❄️" },
        332: { zh: "中雪", emoji: "❄️" },
        335: { zh: "大雪", emoji: "❄️" },
        338: { zh: "大雪", emoji: "❄️" },
        350: { zh: "冻雨", emoji: "🌧️" },
        353: { zh: "阵雨", emoji: "🌦️" },
        356: { zh: "阵雨", emoji: "🌦️" },
        359: { zh: "暴雨", emoji: "🌧️" },
        362: { zh: "雨夹雪", emoji: "🌨️" },
        365: { zh: "雨夹雪", emoji: "🌨️" },
        368: { zh: "小雪", emoji: "🌨️" },
        371: { zh: "大雪", emoji: "❄️" },
        374: { zh: "雨夹雪", emoji: "🌨️" },
        377: { zh: "雨夹雪", emoji: "🌨️" },
        386: { zh: "雷阵雨", emoji: "⛈️" },
        389: { zh: "雷暴", emoji: "⛈️" },
        392: { zh: "雷阵雪", emoji: "🌨️" },
        395: { zh: "大雪", emoji: "❄️" }
    };

    function infoByCode(code) {
        return CODE_MAP[code] || { zh: "未知", emoji: "🌡️" };
    }

    /* ---------- 城市列表读写 ---------- */
    function loadCities() {
        const list = Api.store.get(CITIES_KEY, []) || [];
        return Array.isArray(list) ? list : [];
    }
    function saveCities(list) {
        Api.store.set(CITIES_KEY, list);
    }

    let cities = loadCities();
    let currentId = localStorage.getItem(CITY_KEY) || "";

    // 修正：当前选中若已不在列表中，回退到第一个
    if (cities.length && !cities.find(c => c.id === currentId)) {
        currentId = cities[0].id;
        localStorage.setItem(CITY_KEY, currentId);
    }

    function currentCity() {
        return cities.find(c => c.id === currentId) || null;
    }

    /* ---------- 获取天气（带超时 + 代理兜底） ---------- */
    async function fetchWeather(cityName) {
        const target = `https://wttr.in/${encodeURIComponent(cityName)}?format=j1`;

        // 1) 直连（wttr.in 支持 CORS，最快）
        const c1 = new AbortController();
        const t1 = setTimeout(() => c1.abort(), FETCH_TIMEOUT);
        try {
            const res = await fetch(target, { signal: c1.signal });
            if (res.ok) return await res.json();
        } catch (e) {
            // 跨域/超时，走代理
        } finally {
            clearTimeout(t1);
        }

        // 2) 经 CORS 代理重试（也限时，避免卡死）
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), PROXY_TIMEOUT);
        try {
            return await Api.fetchJson(target, { useProxy: true, signal: c2.signal });
        } finally {
            clearTimeout(t2);
        }
    }

    /* ---------- 渲染 ---------- */
    function render(data, city) {
        const cur = data.current_condition && data.current_condition[0];
        if (!cur) { renderFallback(city); return; }

        const area = data.nearest_area && data.nearest_area[0];
        const areaName = area ? area.areaName[0].value : city.name;
        const code = parseInt(cur.weatherCode);
        const info = infoByCode(code);

        const body = document.getElementById("weatherBody");
        if (!body) return;

        body.innerHTML = `
            <div class="weather-main">
                <div class="weather-icon">${info.emoji}</div>
                <div class="weather-temp">
                    <span class="temp-num">${cur.temp_C}</span><span class="temp-unit">°C</span>
                </div>
                <div class="weather-desc">${info.zh}</div>
            </div>
            <div class="weather-city">${escapeHtml(city.name)}</div>
            <div class="weather-details">
                <div class="wd-item"><span class="wd-label">体感</span><span class="wd-value">${cur.FeelsLikeC}°C</span></div>
                <div class="wd-item"><span class="wd-label">湿度</span><span class="wd-value">${cur.humidity}%</span></div>
                <div class="wd-item"><span class="wd-label">风速</span><span class="wd-value">${cur.windspeedKmph} km/h</span></div>
                <div class="wd-item"><span class="wd-label">风向</span><span class="wd-value">${cur.winddir16Point}</span></div>
                <div class="wd-item"><span class="wd-label">能见度</span><span class="wd-value">${cur.visibility} km</span></div>
                <div class="wd-item"><span class="wd-label">气压</span><span class="wd-value">${cur.pressure} hPa</span></div>
            </div>
        `;
    }

    /* ---------- 友好失败提示（可重试） ---------- */
    function renderFail(city) {
        const body = document.getElementById("weatherBody");
        if (!body) return;
        body.innerHTML = `
            <div class="weather-fail">
                <div class="wf-emoji">🌧️</div>
                <div class="wf-text">「${escapeHtml(city.name)}」天气暂时取不到</div>
                <div class="wf-sub">可能是网络波动，或城市名拼写需调整（试试拼音 / 英文）</div>
                <button class="btn btn-ghost btn-sm" id="weatherRetry" type="button">重试</button>
            </div>`;
        const retry = document.getElementById("weatherRetry");
        if (retry) retry.addEventListener("click", load);
    }

    /* ---------- 示例数据兜底（结构异常时） ---------- */
    function renderFallback(city) {
        const body = document.getElementById("weatherBody");
        if (!body) return;
        const name = city ? city.name : "未知城市";
        body.innerHTML = `
            <div class="weather-main">
                <div class="weather-icon">🌤️</div>
                <div class="weather-temp"><span class="temp-num">25</span><span class="temp-unit">°C</span></div>
                <div class="weather-desc">晴间多云</div>
            </div>
            <div class="weather-city">${escapeHtml(name)}（示例数据）</div>
            <div class="weather-details">
                <div class="wd-item"><span class="wd-label">体感</span><span class="wd-value">26°C</span></div>
                <div class="wd-item"><span class="wd-label">湿度</span><span class="wd-value">60%</span></div>
                <div class="wd-item"><span class="wd-label">风速</span><span class="wd-value">10 km/h</span></div>
                <div class="wd-item"><span class="wd-label">提示</span><span class="wd-value">天气服务暂不可用</span></div>
            </div>
        `;
    }

    /* ---------- 城市栏渲染 ---------- */
    function renderCityBar() {
        const bar = document.getElementById("weatherCityBar");
        if (!bar) return;

        if (!cities.length) {
            bar.innerHTML = '<div class="weather-empty">还没有城市，在下方添加你关注的城市吧～</div>';
            return;
        }

        bar.innerHTML = cities.map(c => `
            <div class="city-chip ${c.id === currentId ? "active" : ""}" data-id="${c.id}">
                <span class="chip-name" data-edit="${c.id}">${escapeHtml(c.name)}</span>
                <button class="chip-edit" data-edit="${c.id}" title="改名" type="button" aria-label="改名">✎</button>
                <button class="chip-del" data-del="${c.id}" title="删除" type="button" aria-label="删除">×</button>
            </div>
        `).join("");

        // 切换城市（点击 chip 主体，避开编辑/删除按钮）
        bar.querySelectorAll(".city-chip").forEach(chip => {
            chip.addEventListener("click", e => {
                if (e.target.closest(".chip-edit") || e.target.closest(".chip-del")) return;
                selectCity(chip.dataset.id);
            });
        });
        // 删除
        bar.querySelectorAll(".chip-del").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                removeCity(btn.dataset.del);
            });
        });
        // 改名
        bar.querySelectorAll(".chip-edit").forEach(btn => {
            btn.addEventListener("click", e => {
                e.stopPropagation();
                startEdit(btn.dataset.edit);
            });
        });
    }

    /* ---------- 改名（行内编辑） ---------- */
    function startEdit(id) {
        const chip = document.querySelector(`.city-chip[data-id="${id}"]`);
        if (!chip) return;
        const nameSpan = chip.querySelector(".chip-name");
        const old = nameSpan.textContent.trim();
        chip.classList.add("editing");
        nameSpan.outerHTML = `<input class="chip-edit-input" type="text" value="${escapeHtml(old)}" maxlength="30" />`;
        const input = chip.querySelector(".chip-edit-input");
        input.focus();
        input.select();
        const commit = () => {
            const v = input.value.trim();
            if (v && v !== old) renameCity(id, v);
            else renderCityBar(); // 取消
        };
        input.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); renderCityBar(); }
        });
        input.addEventListener("blur", commit);
    }

    /* ---------- 添加城市 ---------- */
    function addCity() {
        const input = document.getElementById("weatherAddInput");
        if (!input) return;
        const name = input.value.trim();
        if (!name) { input.focus(); return; }

        // 查重（忽略大小写）
        if (cities.find(c => c.name.toLowerCase() === name.toLowerCase())) {
            Api.showToast("该城市已在列表中", "info");
            input.value = "";
            input.focus();
            return;
        }

        const id = "c" + Date.now().toString(36);
        cities.push({ id, name });
        saveCities(cities);
        input.value = "";
        const first = !currentId;
        // 若此前没有城市，自动选中新加的
        if (first) {
            currentId = id;
            localStorage.setItem(CITY_KEY, id);
        }
        renderCityBar();
        Api.showToast(`已添加 ${name}`, "success");
        input.focus(); // 方便连续添加
        if (first) load();
    }

    /* ---------- 删除城市 ---------- */
    function removeCity(id) {
        const idx = cities.findIndex(c => c.id === id);
        if (idx < 0) return;
        const removed = cities[idx];
        cities.splice(idx, 1);
        saveCities(cities);

        if (currentId === id) {
            currentId = cities.length ? cities[0].id : "";
            localStorage.setItem(CITY_KEY, currentId);
        }
        renderCityBar();
        if (currentId) load();
        else {
            const body = document.getElementById("weatherBody");
            if (body) body.innerHTML = '<p class="loading-text">在下方添加城市，即可查看天气 ☁️</p>';
        }
        Api.showToast(`已删除 ${removed.name}`, "info");
    }

    /* ---------- 改名提交 ---------- */
    function renameCity(id, newName) {
        const c = cities.find(x => x.id === id);
        if (!c) return;
        c.name = newName;
        saveCities(cities);
        renderCityBar();
        if (currentId === id) load();
        Api.showToast("已更新城市名", "success");
    }

    /* ---------- 切换城市 ---------- */
    function selectCity(id) {
        if (currentId === id) return;
        currentId = id;
        localStorage.setItem(CITY_KEY, id);
        renderCityBar();
        load();
    }

    /* ---------- 加载 ---------- */
    async function load() {
        const body = document.getElementById("weatherBody");
        if (!body) return;
        const city = currentCity();
        if (!city) {
            body.innerHTML = '<p class="loading-text">在下方添加城市，即可查看天气 ☁️</p>';
            return;
        }
        body.innerHTML = `<p class="loading-text">正在获取 ${escapeHtml(city.name)} 的天气…</p>`;
        try {
            const data = await fetchWeather(city.name);
            render(data, city);
        } catch (e) {
            console.warn("天气获取失败:", e);
            renderFail(city);
        }
    }

    /* ---------- 初始化 ---------- */
    function init() {
        const input = document.getElementById("weatherAddInput");
        const addBtn = document.getElementById("weatherAddBtn");
        let composing = false;
        if (input) {
            // 中文输入法组合期间不误触发
            input.addEventListener("compositionstart", () => composing = true);
            input.addEventListener("compositionend", () => composing = false);
            input.addEventListener("keydown", e => {
                if (e.key === "Enter" && !composing) { e.preventDefault(); addCity(); }
            });
        }
        if (addBtn) addBtn.addEventListener("click", addCity);

        renderCityBar();
        load();
    }

    function refresh() { load(); }

    return { init, refresh };
})();
