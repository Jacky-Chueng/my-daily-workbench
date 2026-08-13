# 我的每日学习工作台

一个纯前端单页应用，集成**每日英语学习、今日黄历、国际新闻、日程记录、心情记录**五大功能，所有数据保存在浏览器本地（localStorage），开箱即用。

## ✨ 功能一览

| 模块 | 功能 |
|------|------|
| 📖 每日英语 | 从 The Guardian / BBC / Reuters RSS 获取最新文章，英中对照展示，每段一键翻译，全文翻译，生词库 |
| 🗃️ 生词库 | 选中文章中的单词即可添加，自动翻译释义，支持删除 / 导出 TXT / 导出 JSON |
| 📅 今日黄历 | 公历、农历、宜忌（mxnzp API，未配置则用模拟数据） |
| 🌍 国际新闻 | 6 则国际头条（NewsAPI 优先，RSS 兜底，示例数据保底） |
| ✅ 今日日程 | 待办事项增删改，按天存储，只显示当天 |
| 🙂 每日心情 | 6 种表情 + 文字备注，7 天历史记录 |
| 🎨 主题 | 浅色 / 深色一键切换，跟随系统偏好，响应式适配手机 |

## 🚀 快速开始

### 方式一：本地直接打开
直接用浏览器打开 `index.html` 即可运行（推荐使用 Chrome / Edge）。

> ⚠️ 由于浏览器安全策略，直接以 `file://` 方式打开时，部分跨域请求（RSS、翻译 API）可能受限。建议使用本地服务器（见方式二）。

### 方式二：本地服务器（推荐）
任选一种：

```bash
# Python 3
python -m http.server 8080

# Node.js（需先 npm i -g serve）
serve .
```
然后访问 `http://localhost:8080`。

## 🔧 配置 API Key

打开 `js/config.js`，按需填写以下配置（**全部可选**，留空时会自动使用兜底数据）：

### 1. 黄历 API（mxnzp）
1. 访问 https://www.mxnzp.com/register 注册账号
2. 创建应用获取 `app_id` 和 `app_secret`
3. 填入 `config.js`：
```js
almanac: {
    appId: "你的app_id",
    appSecret: "你的app_secret",
    ...
}
```

### 2. 国际新闻 NewsAPI
1. 访问 https://newsapi.org/register 注册获取 Key
2. 填入 `config.js`：
```js
newsApi: {
    apiKey: "你的key",
    ...
}
```
> 💡 NewsAPI 免费开发版仅支持服务器端调用。浏览器直连受 CORS 限制，本项目会自动经 CORS 代理转发；如不稳定，留空即可使用 RSS 兜底（同样能获取 BBC/Guardian 国际新闻）。

### 3. CORS 代理
RSS 与部分 API 需经 CORS 代理转发。默认使用公共代理 `https://api.allorigins.win/raw?url=`（有速率限制）。如需更稳定，可自建：
- [cors-anywhere](https://github.com/Rob--W/cors-anywhere)
- 或部署到 Vercel/Cloudflare Workers 写一个简单代理

修改 `config.js` 中：
```js
corsProxy: "https://你的代理地址?url="
```

### 4. 翻译 API
默认使用 LibreTranslate 公共实例 `https://translate.argosopentech.com/translate`（免费、免 Key，但有速率限制）。失败时自动回退到 MyMemory 翻译 API。如需自建：
- [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate)

## 📦 部署上线

### 方案 A：GitHub Pages（免费）
1. 在 GitHub 创建仓库，上传本项目所有文件
2. 进入仓库 **Settings → Pages**
3. Source 选择 `main` 分支，目录选 `/ (root)`
4. 保存后约 1 分钟，访问 `https://用户名.github.io/仓库名/`

### 方案 B：Vercel（免费，支持自定义域名）
1. 注册 https://vercel.com
2. 点击 **New Project**，导入 GitHub 仓库
3. Framework Preset 选 **Other**，Build Command 留空，Output Directory 填 `.`
4. 点击 Deploy，几秒后即可获得线上地址

### 方案 C：Cloudflare Pages（免费）
1. 注册 https://pages.cloudflare.com
2. 连接 Git 仓库
3. 构建命令留空，输出目录填 `/`
4. 部署完成

## 📁 项目结构

```
daily-workbench/
├── index.html              # 主页面
├── css/
│   └── styles.css          # 全部样式（含主题变量、响应式）
├── js/
│   ├── config.js           # API Key 与端点配置
│   ├── api.js              # 通用工具：fetch/RSS解析/翻译/Toast
│   ├── vocabulary.js       # 生词库模块
│   ├── daily-english.js    # 每日英语模块（核心）
│   ├── almanac.js          # 今日黄历模块
│   ├── news.js             # 国际新闻模块
│   ├── todo.js             # 日程记录模块
│   ├── mood.js             # 心情记录模块
│   └── app.js              # 主入口：主题、刷新、模块初始化
└── README.md               # 本文件
```

## 💡 使用说明

- **每日英语**：顶部下拉框切换新闻源（The Guardian / BBC / Reuters）；点击"换一篇"切换文章；点击"一键翻译"翻译单段，或"翻译全文"批量翻译。
- **生词库**：用鼠标在英文段落中选中一个单词，底部会浮出"添加到生词库"按钮，点击即自动翻译并保存。支持导出 TXT/JSON。
- **日程记录**：每天独立存储，次日自动新建。
- **心情记录**：每天可保存一次，再次保存会覆盖当天。
- **主题**：右上角 🌙/☀️ 按钮切换，记忆你的选择。

## ⚠️ 常见问题

**Q: 英语文章加载失败？**
A: 多为 CORS 代理被限流。请稍后重试，或在 `config.js` 更换 `corsProxy` 为其他公共代理 / 自建代理。页面会自动展示示例文章保证可用。

**Q: 翻译不出来？**
A: LibreTranslate 公共实例有速率限制，频繁请求可能被拒。等待片刻或自建实例即可。翻译失败不影响阅读原文。

**Q: 数据会丢失吗？**
A: 所有数据存在浏览器 localStorage，清除浏览器数据时会一并清除。建议定期用"导出 JSON"备份生词库。

## 📜 技术栈
- 纯原生 HTML + CSS + JavaScript（无框架、无构建步骤）
- CSS 变量驱动主题
- localStorage 持久化
- Fetch API + RSS + DOMParser
