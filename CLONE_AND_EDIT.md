# 在另一台电脑上修改本工作台

本仓库是一个纯静态网站（HTML + CSS + 原生 JS，无构建步骤）。
代码存在这里 + GitHub；你的个人数据（生词/待办/心情）存在浏览器本地。

---

## 一、两类内容，两种跨电脑方式

| 你要改的东西 | 存在哪里 | 跨电脑怎么做 |
|-------------|---------|------------|
| 网站功能 / 样式 / 布局（代码） | 本地项目文件夹 + GitHub | 新电脑 `git clone` → 用 WorkBuddy 改 → `commit` + `push` |
| 生词库 / 待办 / 心情记录（数据） | 浏览器 localStorage | 任意电脑开浏览器访问线上网址；用「导出/导入 JSON」搬运 |

> 简言之：**代码靠 git 当桥梁（clone → 改 → push），数据靠浏览器 + 导出导入。**

---

## 二、在新电脑上修改代码（clone → 改 → push）

### 1. 准备环境
- 安装 [Git](https://git-scm.com/downloads)
- 安装 WorkBuddy（或任意编辑器）
- 准备 GitHub 身份验证方式（二选一）：
  - ** Personal Access Token（推荐新手）**：GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic) → 生成，勾选 `repo` 权限。令牌只显示一次，请复制保存。
  - ** SSH 密钥（更一劳永逸）**：本地生成 `ssh-keygen`，把公钥 `~/.ssh/id_ed25519.pub` 内容添加到 GitHub → Settings → SSH and GPG keys。

### 2. 克隆仓库
```bash
git clone https://github.com/Jacky-Chueng/my-daily-workbench.git
# 若用 SSH：git clone git@github.com:Jacky-Chueng/my-daily-workbench.git
cd my-daily-workbench
```

### 3. 用 WorkBuddy 打开并修改
- 用 WorkBuddy 打开 `my-daily-workbench` 文件夹
- 直接编辑 `index.html` / `css/styles.css` / `js/*.js` 即可（纯前端，无需安装依赖）

### 4. 提交并推送
```bash
git add -A
git commit -m "说明这次改了什么"
git push
```
- 若用令牌且远程是 HTTPS，首次 push 时会要求输入用户名（填 GitHub 用户名 `Jacky-Chueng`）和密码（**填令牌，不是登录密码**）。
- 想避免每次输入，可让 git 记住凭据：
  ```bash
  git config --global credential.helper store   # 明文存盘，适合个人机
  ```
  或在远程 URL 中嵌入令牌（用完注意清除）：
  ```bash
  git remote set-url origin https://<你的令牌>@github.com/Jacky-Chueng/my-daily-workbench.git
  # push 后再改回：git remote set-url origin https://github.com/Jacky-Chueng/my-daily-workbench.git
  ```

### 5. 线上自动更新
若已开启 GitHub Pages（Settings → Pages → Deploy from a branch → main → /root），
push 后约 30 秒~2 分钟自动重新部署，硬刷新（`Ctrl+Shift+R`）即可看到改动。

---

## 三、在新电脑上使用 / 搬运数据

1. 浏览器打开 `https://jacky-chueng.github.io/my-daily-workbench/`
2. 数据从空白开始。要带走在旧电脑的记录：
   - 旧电脑：侧边栏底部 **导出数据** → 下载 JSON
   - 新电脑：侧边栏底部 **导入数据** → 上传该 JSON（覆盖写入本地）
3. 之后换电脑都靠这套「导出 / 导入」逻辑同步个人数据。

---

## 四、SSH 免密推送（推荐，一次性配置）

配置一次后，这台机器 `git push` 永远不再需要令牌/密码。SSH 密钥是**按机器生成**的，所以"在哪台机器 push，就在哪台机器生成"。

### 1. 生成密钥（每台机器跑一次）
```bash
git config --global user.name "Jacky-Chueng"
git config --global user.email "602731824@qq.com"
ssh-keygen -t ed25519 -C "602731824@qq.com" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub   # 把输出的整行公钥复制下来
```

### 2. 把公钥加到 GitHub
GitHub → 头像 → **Settings** → 左侧底 **SSH and GPG keys** → **New SSH key**
- Title：填便于识别的名字（如 `workbuddy-pc`）
- Key type：保持 Authentication Key
- Key：粘贴上一步 `cat` 出来的那行 `ssh-ed25519 AAAA...`
- 点 **Add SSH key**

### 3. 首次连接信任 GitHub 主机密钥
```bash
ssh -o StrictHostKeyChecking=accept-new -T git@github.com
# 看到 "Hi Jacky-Chueng! You've successfully authenticated" 即成功
```

### 4. 把仓库远程地址改成 SSH（已 clone 过的仓库才需要）
```bash
git remote set-url origin git@github.com:Jacky-Chueng/my-daily-workbench.git
git remote -v   # 确认显示 git@github.com:... 即成功
```
之后 `git clone` 也直接用 SSH 地址：`git clone git@github.com:Jacky-Chueng/my-daily-workbench.git`

> 多台电脑：每台重新生成一对密钥、各往 GitHub 加一条 SSH key 即可，互不冲突。

---

## 五、本地预览（不依赖线上）
```bash
cd my-daily-workbench
python -m http.server 8080
# 浏览器访问 http://localhost:8080
```

---

## 常见问题

**Q：为什么不能直接在 WorkBuddy 里改线上网站？**
A：WorkBuddy 编辑的是本地文件，它不托管你的网站。线上文件来自 GitHub 仓库，所以要先 clone 到本地改、再 push 回去。

**Q：新电脑 push 提示 403 / 要密码但密码不对？**
A：GitHub 自 2021 年起禁用账号密码登录 git，必须用令牌（或 SSH）。见上文「准备环境」。

**Q：数据怎么在多台电脑/手机间自动同步？**
A：本项目已接入 **Supabase 云同步**（见 `SUPABASE_SETUP.md`）。生词/待办/心情会自动上传到云端，任意设备打开线上网址即自动拉取、一端改动另一端约 1 秒刷新。「导出/导入 JSON」作为离线备份仍可用，但日常已无需手动搬运。
