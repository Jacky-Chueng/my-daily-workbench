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
       五、每日要闻：中文 RSS 源（国内 + 国际混合 · 按重要性排序）
       ✅ 无需修改。通过 rss2json 服务转换为 JSON（支持 CORS）。
       每个分组都是「聚合源」：同时抓取多个 feed，去重后按编辑重要性
       交错混合（国内/国际均衡），取前 newsCount 则。
       如需新增新闻源，在对应分组的 feeds 数组里加一条即可。
       ================================================================= */
    newsSources: {
        // 综合要闻（默认）：国内 + 国际头条混合，按重要性取前 8 则
        headline: {
            name: "综合要闻",
            aggregate: true,
            feeds: [
                { name: "新华网·要闻", feed: "http://www.xinhuanet.com/politics/news_politics.xml", region: "domestic" },
                { name: "人民网·国内", feed: "http://www.people.com.cn/rss/politics.xml", region: "domestic" },
                { name: "中国新闻网",   feed: "http://www.chinanews.com.cn/rss/scroll-news.xml", region: "domestic" },
                { name: "新华网·国际", feed: "http://www.xinhuanet.com/world/news_world.xml", region: "international" },
                { name: "中国新闻网·国际", feed: "http://www.chinanews.com.cn/rss/world.xml", region: "international" },
                { name: "BBC中文",    feed: "http://www.bbc.co.uk/zhongwen/simp/index.xml", region: "international" }
            ]
        },
        // 国内
        domestic: {
            name: "国内",
            aggregate: true,
            feeds: [
                { name: "新华网·要闻", feed: "http://www.xinhuanet.com/politics/news_politics.xml", region: "domestic" },
                { name: "人民网·国内", feed: "http://www.people.com.cn/rss/politics.xml", region: "domestic" },
                { name: "中国新闻网",   feed: "http://www.chinanews.com.cn/rss/scroll-news.xml", region: "domestic" }
            ]
        },
        // 国际
        international: {
            name: "国际",
            aggregate: true,
            feeds: [
                { name: "新华网·国际", feed: "http://www.xinhuanet.com/world/news_world.xml", region: "international" },
                { name: "中国新闻网·国际", feed: "http://www.chinanews.com.cn/rss/world.xml", region: "international" },
                { name: "BBC中文",    feed: "http://www.bbc.co.uk/zhongwen/simp/index.xml", region: "international" }
            ]
        }
    },
    rss2json: "https://api.rss2json.com/v1/api.json?rss_url=",
    newsCount: 8,

    /* =================================================================
       六、今日天气
       ✅ 无需修改。使用 wttr.in 免费天气服务（无需 API Key）。
       城市列表不再预设——由用户在页面上自行添加/删除/改名，
       仅保存在浏览器 localStorage（键 dw_weather_cities），不在此写死。
       ================================================================= */
    weather: {
        defaultCity: "",
        cities: []
    },

    /* =================================================================
       八、云同步（Supabase）—— 跨设备/手机自动同步，免导出导入
       【需填写】按以下步骤开启：
         1. 打开 https://supabase.com 注册并新建一个项目（免费，无需信用卡）
         2. 在项目的 SQL Editor 里执行本仓库 SUPABASE_SETUP.md 中的建表语句
         3. 打开 Project Settings → API，复制 Project URL 和 anon public key
         4. 填入下面的 url / anonKey，并把 enabled 改为 true
       说明：
         - 数据只同步生词库 / 待办 / 心情三类用户数据，主题等偏好不同步
         - 采用「远端优先 + 保留本地离线新增」的合并策略，多设备不会互相覆盖
         - 纯前端网站公开 anon key 属正常做法（个人自用数据风险低）
       ================================================================= */
    supabase: {
        url: "https://cvjlmkmbodembszqjqso.supabase.co",
        anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2amxta21ib2RlbWJzenFqcXNvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MDQzNjgsImV4cCI6MjEwMjE4MDM2OH0.BTz3ZVDlaWr-0V6EwrEfJNXFHkWLBMF5jXheg2DYk3c",
        enabled: true,
        syncId: "main"           // 同一份数据的标识，一般不用改
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
        articleIndex: "dw_article_idx_",
        homeLayout: "dw_home_layout"     // 首页自定义布局（排序+显隐）
    }
};
