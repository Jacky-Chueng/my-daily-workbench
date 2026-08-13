# 云同步开启指南（Supabase）

本工作台默认把数据存在**浏览器本地**，换设备不会跟过来。按以下步骤接入 Supabase 后，
**生词库 / 待办 / 心情** 会在你的电脑、手机等多设备间自动同步，不再需要「导出 / 导入」。

> 全程免费、无需信用卡。整个过程约 5 分钟。

---

## 第 1 步：注册并新建 Supabase 项目

1. 打开 https://supabase.com ，点击 **Start your project** 注册（可用 GitHub 登录）。
2. 登录后点 **New project**。
3. 填：
   - **Name**：`daily-workbench`（随意）
   - **Database Password**：记一下（之后用不到，但创建时要填）
   - **Region**：选离你近的，如 **Northeast Asia (Tokyo)** 或 **Singapore**
4. 点 **Create new project**，等约 1 分钟初始化完成。

---

## 第 2 步：建数据表（复制下面 SQL 执行）

1. 左侧菜单点 **SQL Editor**（或 **Table Editor** 旁边的 SQL 图标）。
2. 点 **New query**，把下面整段粘贴进去，**Run**：

```sql
-- 同步数据表：所有设备读写同一行（id = 'main'）
create table if not exists sync_data (
  id          text primary key,
  payload     jsonb not null,
  updated_at  timestamptz default now()
);

-- 开启行级安全（标准做法）
alter table sync_data enable row level security;

-- 允许匿名（前端）读写：个人自用，数据敏感度低
create policy "allow anon all"
  on sync_data
  for all
  to anon
  using (true)
  with check (true);
```

执行后看到 `Success` 即代表表已建好。

---

## 第 3 步：复制密钥填进 config.js

1. 左侧菜单点 **Project Settings** → **API**。
2. 复制两样东西：
   - **Project URL**（形如 `https://xxxx.supabase.co`）
   - **anon public key**（一长串 `eyJ...`）
3. 打开本仓库的 `js/config.js`，找到最底部的 `supabase` 配置块，改成：

```js
supabase: {
    url: "https://你的ProjectURL.supabase.co",   // 粘贴 Project URL
    anonKey: "你的anonKey",                        // 粘贴 anon public key
    enabled: true,                                // ← 这行改成 true
    syncId: "main"
}
```

> ⚠️ 把 `【需填写】` 字样整个替换掉，只保留真实的 URL 和 key；`enabled` 必须改成 `true` 才会启用。

---

## 第 4 步：部署并验证

- **GitHub Pages 用户**：把改动 `commit` + `push` 上去，等几十秒重新部署。
- **本地预览**：直接 `python -m http.server` 打开即可。

打开网站后，看左侧侧边栏底部：
- 显示 **☁ 已同步** → 成功！任意设备改动，其他设备刷新（或自动，约 1 秒内）即同步。
- 显示 **⚠ 同步失败** → 点它重试；多半是 URL / key 填错，或第 2 步 SQL 没跑。
- 显示 **☁ 未开启云同步** → 说明 `enabled` 还是 `false` 或没填 key。

---

## 同步规则说明

- **同步范围**：仅生词库、待办、心情三类用户数据。主题（浅/深色）等偏好**不**同步，各设备独立。
- **合并策略**：云端优先；若某台设备离线时新增了内容，联网后会保留（不会互相覆盖）。
- **冲突**：同一天的心情、同一条待办，以「最后保存」的一方为准（last-write-wins）。
- **隐私**：纯前端网站公开 anon key 是正常做法；同步的是你个人的待办/心情/生词，敏感度低。
  若你介意，可把第 2 步的 policy 改为带密码校验，或改用自建后端。

---

## 常见问题

**Q：手机上怎么用？**
A：手机浏览器打开 `https://jacky-chueng.github.io/my-daily-workbench/`（或你的部署地址），
   数据会自动从云端拉取；改动后也会自动上传。无需额外操作。

**Q：之前导出的 JSON 还能用吗？**
A：能。「导出 / 导入」功能保留，可作为额外备份手段，与云同步互不冲突。

**Q：换电脑还要 clone 代码吗？**
A：改**网站功能/样式**才需要 clone + 用 WorkBuddy 编辑（见 `CLONE_AND_EDIT.md`）。
   单纯**使用 + 同步数据**只需浏览器打开网址，数据全自动。

**Q：想彻底清掉云端数据？**
A：Supabase 后台 → Table Editor → `sync_data` 表 → 删掉那一行即可。
