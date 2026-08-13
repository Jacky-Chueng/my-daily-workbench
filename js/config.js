/* =====================================================================
   config.js — 全局配置文件
   ---------------------------------------------------------------------
   ⚠️ 需要用户自行填写的字段已用 【需填写】 标注。
   ✅ 无标注的字段无需修改，开箱即用。

   当前架构下大部分功能无需 API Key：
   - 黄历：内置农历算法，本地计算，无需 Key
   - 天气：使用 wttr.in 免费服务，无需 Key
   - 新闻：使用 rss2json + 中文 RSS，无需 Key
   - 翻译：使用 LibreTranslate 公共实例，无需 Key
   - 英语文章：通过 CORS 代理获取 RSS，无需 Key

   只有以下字段可能需要填写（均可选，不填不影响使用）：
   【需填写】corsProxy       —— 若默认公共代理不稳定，可换成自建代理
   【需填写】translateApi    —— 若翻译不稳定，可换成自建 LibreTranslate 实例
   ===================================================================== */

window.APP_CONFIG = {

    /* =================================================================
       一、每日英语：RSS 文章源
       ✅ 无需修改。如需新增/修改新闻源，编辑下方 feeds 数组即可。
       ================================================================= */
    rssSources: {
        guardian: {
            name: "The Guardian",
            feeds: [
                "https://www.theguardian.com/world/rss",
                "https://www.theguardian.com/international/rss",
                "https://www.theguardian.com/science/rss"
            ]
        },
        bbc: {
            name: "BBC News",
            feeds: [
                "https://feeds.bbci.co.uk/news/world/rss.xml",
                "https://feeds.bbci.co.uk/news/rss.xml"
            ]
        },
        reuters: {
            name: "Reuters",
            feeds: [
                "https://feeds.reuters.com/reuters/worldNews",
                "https://rss.nytimes.com/services/xml/rss/nyt/world.xml"
            ]
        }
    },

    /* =================================================================
       二、CORS 代理
       【需填写】若默认代理不可用，替换为你的代理地址。
       浏览器直接请求 RSS 会跨域，需经代理转发。
       可选公共代理（有速率限制），也可自建：
         - https://api.allorigins.win/raw?url=       （默认）
         - https://corsproxy.io/?url=
         - https://cors-anywhere.herokuapp.com/      （需手动激活）
       若部署到自己的服务器，建议自建代理以稳定运行。
       ================================================================= */
    corsProxy: "https://api.allorigins.win/raw?url=",

    /* =================================================================
       三、翻译 API
       【需填写】若翻译不稳定，替换为自建 LibreTranslate 实例地址。
       使用 LibreTranslate 公共实例（免费、无需 Key，但有速率限制）。
       自建教程：https://github.com/LibreTranslate/LibreTranslate
       备选：MyMemory（https://mymemory.translated.net/api/）会自动兜底
       ================================================================= */
    translateApi: "https://translate.argosopentech.com/translate",
    translateSource: "en",
    translateTarget: "zh",

    /* =================================================================
       四、今日黄历
       ✅ 无需修改。已改为内置农历算法本地计算，无需任何 API Key。
       （以下配置保留但不再使用，可忽略）
       ================================================================= */
    almanac: {
        appId: "",
        appSecret: "",
        endpoint: "https://www.mxnzp.com/api/calendar/day"
    },

    /* =================================================================
       五、每日国际新闻：中文 RSS 源
       ✅ 无需修改。通过 rss2json 服务转换为 JSON（支持 CORS）。
       如需新增新闻源，在此添加一条即可，页面下拉框会自动出现。
       ================================================================= */
    newsSources: {
        chinanews: {
            name: "中新网·即时",
            feed: "http://www.chinanews.com.cn/rss/scroll-news.xml"
        },
        xinhua: {
            name: "新华网·国际",
            feed: "http://www.xinhuanet.com/world/news_world.xml"
        },
        people: {
            name: "人民网·国际",
            feed: "http://www.people.com.cn/rss/world.xml"
        }
    },
    rss2json: "https://api.rss2json.com/v1/api.json?rss_url=",
    newsCount: 6,

    /* =================================================================
       六、今日天气
       ✅ 无需修改。使用 wttr.in 免费天气服务（无需 API Key）。
       如需新增城市，在 cities 数组中添加 { value: "拼音", label: "中文名" }。
       ================================================================= */
    weather: {
        defaultCity: "Beijing",
        cities: [
            { value: "Beijing", label: "北京" },
            { value: "Shanghai", label: "上海" },
            { value: "Guangzhou", label: "广州" },
            { value: "Shenzhen", label: "深圳" },
            { value: "Hangzhou", label: "杭州" },
            { value: "Chengdu", label: "成都" },
            { value: "Wuhan", label: "武汉" },
            { value: "Nanjing", label: "南京" },
            { value: "Xian", label: "西安" },
            { value: "Chongqing", label: "重庆" }
        ]
    },

    /* =================================================================
       七、localStorage 键名
       ✅ 请勿修改。修改会导致已有数据无法读取。
       ================================================================= */
    storageKeys: {
        vocabulary: "dw_vocab_list",
        todos: "dw_todos",
        todosLegacy: "dw_todos_",
        moods: "dw_moods",
        theme: "dw_theme",
        articleIndex: "dw_article_idx_"
    }
};
