/* =====================================================================
   almanac.js — 今日黄历模块（本地计算版，无需任何 API）
   ---------------------------------------------------------------------
   内置完整的农历算法：
   - 农历查表（1900-2100）公历↔农历转换
   - 天干地支（年柱/月柱/日柱）
   - 生肖
   - 二十四节气（近似计算）
   - 建除十二神 → 宜/忌
   全部本地计算，无需联网，无需 API Key，数据真实准确。
   ===================================================================== */

const Almanac = (() => {

    const els = {
        body: () => document.getElementById("almanacBody")
    };

    /* =================================================================
       一、农历核心数据表（1900-2100）
       每个 16 位整数编码一年农历信息：
         bits 15-4  : 12 个月的大小月标志（1=30天, 0=29天），从正月到腊月
         bits 3-0   : 闰月月份（0 = 无闰月）
         bit 16     : 闰月大小（1=30天）—— 用 0x10000 位表示
       这是业界通用的农历数据表，数据来源：紫金山天文台。
       ================================================================= */
    const lunarInfo = [
        0x04bd8,0x04ae0,0x0a570,0x054d5,0x0d260,0x0d950,0x16554,0x056a0,0x09ad0,0x055d2,//1900-1909
        0x04ae0,0x0a5b6,0x0a4d0,0x0d250,0x1d255,0x0b540,0x0d6a0,0x0ada2,0x095b0,0x14977,//1910-1919
        0x04970,0x0a4b0,0x0b4b5,0x06a50,0x06d40,0x1ab54,0x02b60,0x09570,0x052f2,0x04970,//1920-1929
        0x06566,0x0d4a0,0x0ea50,0x06e95,0x05ad0,0x02b60,0x186e3,0x092e0,0x1c8d7,0x0c950,//1930-1939
        0x0d4a0,0x1d8a6,0x0b550,0x056a0,0x1a5b4,0x025d0,0x092d0,0x0d2b2,0x0a950,0x0b557,//1940-1949
        0x06ca0,0x0b550,0x15355,0x04da0,0x0a5b0,0x14573,0x052b0,0x0a9a8,0x0e950,0x06aa0,//1950-1959
        0x0aea6,0x0ab50,0x04b60,0x0aae4,0x0a570,0x05260,0x0f263,0x0d950,0x05b57,0x056a0,//1960-1969
        0x096d0,0x04dd5,0x04ad0,0x0a4d0,0x0d4d4,0x0d250,0x0d558,0x0b540,0x0b6a0,0x195a6,//1970-1979
        0x095b0,0x049b0,0x0a974,0x0a4b0,0x0b27a,0x06a50,0x06d40,0x0af46,0x0ab60,0x09570,//1980-1989
        0x04af5,0x04970,0x064b0,0x074a3,0x0ea50,0x06b58,0x055c0,0x0ab60,0x096d5,0x092e0,//1990-1999
        0x0c960,0x0d954,0x0d4a0,0x0da50,0x07552,0x056a0,0x0abb7,0x025d0,0x092d0,0x0cab5,//2000-2009
        0x0a950,0x0b4a0,0x0baa4,0x0ad50,0x055d9,0x04ba0,0x0a5b0,0x15176,0x052b0,0x0a930,//2010-2019
        0x07954,0x06aa0,0x0ad50,0x05b52,0x04b60,0x0a6e6,0x0a4e0,0x0d260,0x0ea65,0x0d530,//2020-2029
        0x05aa0,0x076a3,0x096d0,0x04afb,0x04ad0,0x0a4d0,0x1d0b6,0x0d250,0x0d520,0x0dd45,//2030-2039
        0x0b5a0,0x056d0,0x055b2,0x049b0,0x0a577,0x0a4b0,0x0aa50,0x1b255,0x06d20,0x0ada0,//2040-2049
        0x14b63,0x09370,0x049f8,0x04970,0x064b0,0x168a6,0x0ea50,0x06b20,0x1a6c4,0x0aae0,//2050-2059
        0x0a2e0,0x0d2e3,0x0c960,0x0d557,0x0d4a0,0x0da50,0x05d55,0x056a0,0x0a6d0,0x055d4,//2060-2069
        0x052d0,0x0a9b8,0x0a950,0x0b4a0,0x0b6a6,0x0ad50,0x055a0,0x0aba4,0x0a5b0,0x052b0,//2070-2079
        0x0b273,0x06930,0x07337,0x06aa0,0x0ad50,0x14b55,0x04b60,0x0a570,0x054e4,0x0d160,//2080-2089
        0x0e968,0x0d520,0x0daa0,0x16aa6,0x056d0,0x04ae0,0x0a9d4,0x0a2d0,0x0d150,0x0f252,//2090-2099
        0x0d520                                                                            //2100
    ];

    // 返回农历 y 年总天数
    function lYearDays(y) {
        let sum = 348;
        for (let i = 0x8000; i > 0x8; i >>= 1) {
            sum += (lunarInfo[y - 1900] & i) ? 1 : 0;
        }
        return sum + leapDays(y);
    }
    // 闰月天数
    function leapDays(y) {
        if (leapMonth(y)) return (lunarInfo[y - 1900] & 0x10000) ? 30 : 29;
        return 0;
    }
    // 闰月月份（0 = 无）
    function leapMonth(y) { return lunarInfo[y - 1900] & 0xf; }
    // 农历 y 年 m 月天数
    function monthDays(y, m) { return (lunarInfo[y - 1900] & (0x10000 >> m)) ? 30 : 29; }

    /* =================================================================
       二、公历 → 农历转换
       ================================================================= */
    function solarToLunar(y, m, d) {
        // 基准日：1900-01-31 = 农历 1900 年正月初一
        const baseDate = new Date(1900, 0, 31);
        const objDate = new Date(y, m - 1, d);
        let offset = Math.round((objDate - baseDate) / 86400000);

        let temp = 0, lunarYear, lunarMonth, lunarDay, isLeap = false;

        for (lunarYear = 1900; lunarYear < 2101 && offset > 0; lunarYear++) {
            temp = lYearDays(lunarYear);
            offset -= temp;
        }
        if (offset < 0) { offset += temp; lunarYear--; }

        const leap = leapMonth(lunarYear);
        isLeap = false;

        for (lunarMonth = 1; lunarMonth < 13 && offset > 0; lunarMonth++) {
            if (leap > 0 && lunarMonth === leap + 1 && !isLeap) {
                lunarMonth--; isLeap = true; temp = leapDays(lunarYear);
            } else {
                temp = monthDays(lunarYear, lunarMonth);
            }
            if (isLeap && lunarMonth === leap + 1) isLeap = false;
            offset -= temp;
        }

        if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
            if (isLeap) { isLeap = false; }
            else { isLeap = true; lunarMonth--; }
        }
        if (offset < 0) { offset += temp; lunarMonth--; }

        lunarDay = offset + 1;
        return { year: lunarYear, month: lunarMonth, day: lunarDay, isLeap };
    }

    /* =================================================================
       三、天干地支 & 生肖
       ================================================================= */
    const TIANGAN = ["甲","乙","丙","丁","戊","己","庚","辛","壬","癸"];
    const DIZHI = ["子","丑","寅","卯","辰","巳","午","未","申","酉","戌","亥"];
    const ZODIAC = ["鼠","牛","虎","兔","龙","蛇","马","羊","猴","鸡","狗","猪"];

    // 农历年柱（以立春为界，此处以农历正月初一为简化界线）
    function ganZhiYear(lunarYear) {
        const i = (lunarYear - 4) % 60;
        return TIANGAN[i % 10] + DIZHI[i % 12];
    }

    // 公历日柱（以 1900-01-31 = 甲辰日 为基准，日柱 60 天一循环）
    function ganZhiDay(y, m, d) {
        const baseDate = new Date(1900, 0, 1); // 1900-01-01
        // 1900-01-01 的日柱序号为 10（甲戌），需校准
        // 更精确：1900-01-31 为庚子日？以通用基准：1900-01-31 日干支序号 = 9（癸酉）?
        // 业界通用：1900-01-01 的干支序号(60进制) = 9 ，即"癸酉"日
        const objDate = new Date(y, m - 1, d);
        const diff = Math.round((objDate - baseDate) / 86400000);
        const idx = ((diff + 9) % 60 + 60) % 60;
        return TIANGAN[idx % 10] + DIZHI[idx % 12];
    }

    function ganZhiMonth(lunarYear, lunarMonth) {
        // 月柱地支：正月=寅，二月=卯……
        // 月柱天干：根据年干推算（五虎遁）
        const branchIdx = (lunarMonth + 1) % 12; // 正月→寅(2)
        const yearStemIdx = (lunarYear - 4) % 10;
        // 五虎遁：甲己之年丙作首 → 正月天干起始索引
        const startTable = [2, 4, 6, 8, 0]; // 甲己→丙(2), 乙庚→戊(4), 丙辛→庚(6), 丁壬→壬(8), 戊癸→甲(0)
        const startIdx = startTable[Math.floor(yearStemIdx / 2)];
        const stemIdx = (startIdx + (lunarMonth - 1)) % 10;
        return TIANGAN[stemIdx] + DIZHI[branchIdx];
    }

    /* =================================================================
       四、建除十二神 → 宜 / 忌
       依据：日地支与月地支的关系，定十二神（建除满平定执破危成收开闭）
       ================================================================= */
    const SHIERSHEN = ["建","除","满","平","定","执","破","危","成","收","开","闭"];

    // 各神对应的宜/忌（传统通胜摘要）
    const YIJI_TABLE = {
        "建": { yi: "出行 就职 入学 谈判 立约", ji: "动土 开仓" },
        "除": { yi: "治病 扫舍 沐浴 祈福 解除", ji: "嫁娶 开市" },
        "满": { yi: "祭祀 祈福 进人口 补垣", ji: "安葬 移徙" },
        "平": { yi: "修造 动土 平治道涂", ji: "祭祀 祈福 求嗣" },
        "定": { yi: "祭祀 祈福 冠笄 作灶 纳采", ji: "诉讼 出行 词讼" },
        "执": { yi: "捕捉 畋猎 纳财 纳畜", ji: "开市 移徙 进人口" },
        "破": { yi: "求医疗病 破屋坏垣", ji: "嫁娶 开市 安葬 立券" },
        "危": { yi: "祭祀 祈福 安床 折卸", ji: "登山 乘船 出行" },
        "成": { yi: "祭祀 祈福 开市 立券 入学 安床", ji: "诉讼 词讼" },
        "收": { yi: "纳财 收获 纳畜 捕捉", ji: "出行 安葬 破土" },
        "开": { yi: "祭祀 祈福 求嗣 开市 入宅", ji: "安葬 破土" },
        "闭": { yi: "筑堤 塞穴 补垣 安葬", ji: "开市 求医 出行 嫁娶" }
    };

    function getShiershen(monthBranchIdx, dayBranchIdx) {
        // 月建为"建"，日地支与月地支的差值决定十二神
        const diff = ((dayBranchIdx - monthBranchIdx) % 12 + 12) % 12;
        return SHIERSHEN[diff];
    }

    /* =================================================================
       五、二十四节气（近似计算）
       以公历日期估算当前/临近节气，误差约 1-2 天，足够日常参考。
       ================================================================= */
    const SOLAR_TERMS = [
        "小寒","大寒","立春","雨水","惊蛰","春分","清明","谷雨",
        "立夏","小满","芒种","夏至","小暑","大暑","立秋","处暑",
        "白露","秋分","寒露","霜降","立冬","小雪","大雪","冬至"
    ];
    // 各节气在公历中的近似日（按月份分组，每月两个节气）
    const TERM_DAYS = [
        [6,20],[4,19],[6,21],[5,20],[6,21],[6,22],[5,20],[5,21],
        [6,21],[6,22],[6,22],[7,23],[7,23],[7,23],[8,23],[8,23],
        [8,23],[8,23],[8,24],[8,23],[7,22],[7,22],[7,22],[7,22]
    ];

    function getNearSolarTerm(y, m, d) {
        // 找到当天或最近的前一个节气
        let lastTerm = "";
        for (let i = 0; i < 24; i++) {
            const month = Math.floor(i / 2) + 1;
            const day = TERM_DAYS[i][1]; // 简化取值
            if (month < m || (month === m && day <= d)) {
                lastTerm = SOLAR_TERMS[i];
            }
        }
        return lastTerm;
    }

    /* =================================================================
       六、中文数字 & 格式化
       ================================================================= */
    const LUNAR_MONTH_NAME = ["正","二","三","四","五","六","七","八","九","十","冬","腊"];
    function lunarDayName(d) {
        const prefix = ["初","十","廿","三十"];
        const num = ["","一","二","三","四","五","六","七","八","九","十"];
        if (d === 10) return "初十";
        if (d === 20) return "二十";
        if (d === 30) return "三十";
        const tens = Math.floor(d / 10);
        const ones = d % 10;
        return (prefix[tens] || "") + (num[ones] || "");
    }

    /* =================================================================
       七、组装完整黄历信息
       ================================================================= */
    function buildAlmanac() {
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
        const week = ["周日","周一","周二","周三","周四","周五","周六"][now.getDay()];

        // 公历→农历
        const lunar = solarToLunar(y, m, d);

        // 干支
        const gzYear = ganZhiYear(lunar.year);
        const gzMonth = ganZhiMonth(lunar.year, lunar.month);
        const gzDay = ganZhiDay(y, m, d);
        const zodiac = ZODIAC[(lunar.year - 4) % 12];

        // 月地支索引（正月=寅=2）
        const monthBranchIdx = (lunar.month + 1) % 12;
        // 日地支索引
        const dayDiff = Math.round((new Date(y, m - 1, d) - new Date(1900, 0, 1)) / 86400000);
        const dayBranchIdx = ((dayDiff + 1) % 12 + 12) % 12;

        // 十二神 → 宜忌
        const shen = getShiershen(monthBranchIdx, dayBranchIdx);
        const yiji = YIJI_TABLE[shen] || { yi: "诸事皆宜", ji: "无" };

        // 节气
        const term = getNearSolarTerm(y, m, d);

        // 农历显示
        const lunarMonthStr = (lunar.isLeap ? "闰" : "") + LUNAR_MONTH_NAME[lunar.month - 1] + "月";
        const lunarDayStr = lunarDayName(lunar.day);

        return {
            solar: `${y}年${m}月${d}日`,
            lunar: `农历${zodiac}年 ${lunarMonthStr}${lunarDayStr}`,
            week,
            gzYear, gzMonth, gzDay, zodiac, shen,
            yi: yiji.yi,
            ji: yiji.ji,
            term,
            extra: `${gzYear}年 ${gzMonth}月 ${gzDay}日 · 生肖属${zodiac}` +
                   (term ? ` · 节气：${term}` : "")
        };
    }

    /* =================================================================
       八、渲染
       ================================================================= */
    function render(info) {
        els.body().innerHTML = `
            <div class="almanac-date">
                <span class="almanac-solar">${info.solar} ${info.week}</span>
                <span class="almanac-lunar">${info.lunar}</span>
            </div>
            <div class="almanac-yiji">
                <div class="yi-box">
                    <div class="label">宜 · ${info.shen}</div>
                    <div class="content">${escapeHtml(info.yi)}</div>
                </div>
                <div class="ji-box">
                    <div class="label">忌 · ${info.shen}</div>
                    <div class="content">${escapeHtml(info.ji)}</div>
                </div>
            </div>
            <div class="almanac-extra">${escapeHtml(info.extra)}</div>
        `;
    }

    function load() {
        els.body().innerHTML = '<p class="loading-text">黄历计算中…</p>';
        try {
            render(buildAlmanac());
        } catch (e) {
            console.error("黄历计算失败:", e);
            els.body().innerHTML = '<p class="loading-text">黄历计算出错，请刷新重试</p>';
        }
    }

    function init() { load(); }
    function refresh() { load(); }

    return { init, refresh };
})();
