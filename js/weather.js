/* =====================================================================
   weather.js — 今日天气模块
   ---------------------------------------------------------------------
   使用 wttr.in 免费天气服务（无需 API Key，支持 CORS）。
   - 展示城市、温度、天气描述（中文）、图标、体感/湿度/风速/风向/能见度/气压
   - 支持城市切换（下拉框）
   - 当前城市记忆到 localStorage
   - 获取失败时展示示例数据
   ===================================================================== */

const Weather = (() => {
    const CFG = window.APP_CONFIG.weather;
    const CITY_KEY = "dw_weather_city";
    let currentCity = localStorage.getItem(CITY_KEY) || CFG.defaultCity;

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

    /* ---------- 获取天气 ---------- */
    async function fetchWeather(city) {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
        // wttr.in 支持 CORS，直接 fetch
        try {
            const res = await fetch(url);
            if (res.ok) return await res.json();
        } catch (e) {
            // 降级到代理
        }
        // 经 CORS 代理重试
        const data = await Api.fetchJson(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, { useProxy: true });
        return data;
    }

    /* ---------- 渲染 ---------- */
    function render(data) {
        const cur = data.current_condition && data.current_condition[0];
        if (!cur) { renderFallback(); return; }

        const area = data.nearest_area && data.nearest_area[0];
        const areaName = area ? area.areaName[0].value : currentCity;
        const code = parseInt(cur.weatherCode);
        const info = infoByCode(code);

        // 城市中文名（从配置查找）
        const cityCfg = CFG.cities.find(c => c.value.toLowerCase() === currentCity.toLowerCase());
        const cityName = cityCfg ? cityCfg.label : areaName;

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
            <div class="weather-city">${escapeHtml(cityName)}</div>
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

    /* ---------- 示例数据兜底 ---------- */
    function renderFallback() {
        const body = document.getElementById("weatherBody");
        if (!body) return;
        const cityCfg = CFG.cities.find(c => c.value.toLowerCase() === currentCity.toLowerCase());
        const cityName = cityCfg ? cityCfg.label : currentCity;
        body.innerHTML = `
            <div class="weather-main">
                <div class="weather-icon">🌤️</div>
                <div class="weather-temp"><span class="temp-num">25</span><span class="temp-unit">°C</span></div>
                <div class="weather-desc">晴间多云</div>
            </div>
            <div class="weather-city">${escapeHtml(cityName)}（示例数据）</div>
            <div class="weather-details">
                <div class="wd-item"><span class="wd-label">体感</span><span class="wd-value">26°C</span></div>
                <div class="wd-item"><span class="wd-label">湿度</span><span class="wd-value">60%</span></div>
                <div class="wd-item"><span class="wd-label">风速</span><span class="wd-value">10 km/h</span></div>
                <div class="wd-item"><span class="wd-label">提示</span><span class="wd-value">天气服务暂不可用</span></div>
            </div>
        `;
    }

    /* ---------- 加载 ---------- */
    async function load() {
        const body = document.getElementById("weatherBody");
        if (!body) return;
        body.innerHTML = '<p class="loading-text">天气加载中…</p>';
        try {
            const data = await fetchWeather(currentCity);
            render(data);
        } catch (e) {
            console.warn("天气获取失败:", e);
            renderFallback();
        }
    }

    /* ---------- 切换城市 ---------- */
    function switchCity(city) {
        currentCity = city;
        localStorage.setItem(CITY_KEY, city);
        load();
    }

    /* ---------- 初始化 ---------- */
    function init() {
        const sel = document.getElementById("weatherCity");
        if (sel) {
            sel.value = currentCity;
            sel.addEventListener("change", e => switchCity(e.target.value));
        }
        load();
    }

    function refresh() { load(); }

    return { init, refresh };
})();
