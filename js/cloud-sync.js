/* =====================================================================
   cloud-sync.js — Supabase 云同步模块
   ---------------------------------------------------------------------
   作用：让生词库 / 待办 / 心情 在电脑、手机等多设备间自动同步，
        免去手动「导出 / 导入」。

   原理：
     - 所有设备读写 Supabase 中同一行（id = syncId）的 JSON 数据包
     - 打开页面时先「拉取云端」覆盖本地，之后任意改动「防抖上传」
     - 合并策略：云端优先；但保留本地离线新增的项（不会互相覆盖）
     - 通过 Supabase Realtime 订阅，一端改动另一端约 1 秒内自动刷新

   依赖：config.js 中 supabase.enabled = true 且填好 url / anonKey；
        页面需加载 Supabase 官方 JS（CDN，见 index.html）。
   ===================================================================== */

const CloudSync = (() => {
    const CFG = window.APP_CONFIG.supabase;
    const KEYS = window.APP_CONFIG.storageKeys;

    let client = null;
    let ready = false;
    let applyingRemote = false;   // 防止「应用云端数据」触发「上传云端」死循环
    let pushTimer = null;
    let statusEl = null;

    // 仅同步这三类用户数据
    const SYNC_KEYS = [KEYS.vocabulary, KEYS.todos, KEYS.moods];

    /* ---------- 状态提示 ---------- */
    function setStatus(state, text) {
        if (!statusEl) return;
        statusEl.className = "sync-status sync-" + state;
        statusEl.textContent = text;
        statusEl.title = state === "error"
            ? "云同步失败，数据仍保存在本机；点击重试"
            : "点击可立即同步一次";
    }

    /* ---------- 收集本地数据 ---------- */
    function collectLocal() {
        const out = {};
        SYNC_KEYS.forEach(k => { out[k] = Api.store.get(k, null); });
        return out;
    }

    /* ---------- 把云端数据写回本地（合并） ---------- */
    function applyToLocal(remote) {
        if (!remote) return;
        applyingRemote = true;
        let changed = false;
        SYNC_KEYS.forEach(k => {
            if (remote[k] !== undefined) {
                const local = Api.store.get(k, null);
                const merged = mergeOne(k, local, remote[k]);
                if (JSON.stringify(merged) !== JSON.stringify(local)) {
                    Api.store.set(k, merged);
                    changed = true;
                }
            }
        });
        applyingRemote = false;
        // 通知各模块重渲染（此时 applyingRemote 已复位，不会触发上传）
        if (changed) window.dispatchEvent(new CustomEvent("dw:dataChanged"));
    }

    /* ---------- 合并策略 ---------- */
    function mergeOne(key, local, remote) {
        if (key === KEYS.vocabulary)
            return mergeArray(local || [], remote || [], w => (w.word || "").toLowerCase());
        if (key === KEYS.todos)
            return mergeArray(local || [], remote || [], t => t.id);
        if (key === KEYS.moods)
            return mergeObject(local || {}, remote || {});
        return remote;
    }

    // 数组：先放本地（保留离线新增），远端按 key 覆盖（云端为准，含编辑/删除）
    function mergeArray(localArr, remoteArr, keyFn) {
        const map = new Map();
        localArr.forEach(it => { if (it != null) map.set(keyFn(it), it); });
        remoteArr.forEach(it => { if (it != null) map.set(keyFn(it), it); });
        return Array.from(map.values());
    }

    // 对象（心情按日期）：远端覆盖同键，保留本地独有键
    function mergeObject(localObj, remoteObj) {
        return Object.assign({}, localObj, remoteObj);
    }

    /* ---------- 拉取云端 ---------- */
    async function pull() {
        if (!ready) return;
        try {
            setStatus("syncing", "☁ 同步中…");
            const { data, error } = await client
                .from("sync_data")
                .select("payload")
                .eq("id", CFG.syncId)
                .maybeSingle();
            if (error) { console.warn("[CloudSync] pull error", error); setStatus("error", "⚠ 同步失败"); return; }
            if (data && data.payload) applyToLocal(data.payload);
            setStatus("ok", "☁ 已同步");
        } catch (e) {
            console.warn("[CloudSync] pull exception", e);
            setStatus("error", "⚠ 同步失败");
        }
    }

    /* ---------- 上传云端（防抖） ---------- */
    function push() {
        if (!ready || applyingRemote) return;   // 应用云端时不回传
        clearTimeout(pushTimer);
        pushTimer = setTimeout(async () => {
            try {
                setStatus("syncing", "☁ 同步中…");
                const payload = collectLocal();
                const { error } = await client
                    .from("sync_data")
                    .upsert({ id: CFG.syncId, payload, updated_at: new Date().toISOString() });
                if (error) { console.warn("[CloudSync] push error", error); setStatus("error", "⚠ 同步失败"); return; }
                setStatus("ok", "☁ 已同步");
            } catch (e) {
                console.warn("[CloudSync] push exception", e);
                setStatus("error", "⚠ 同步失败");
            }
        }, 700);
    }

    /* ---------- Realtime 订阅（一端改动，他端自动刷新） ---------- */
    function subscribeRealtime() {
        try {
            if (!client.channel) return;
            const channel = client
                .channel("sync_data_" + CFG.syncId)
                .on("postgres_changes",
                    { event: "*", schema: "public", table: "sync_data", filter: `id=eq.${CFG.syncId}` },
                    () => pull())
                .subscribe();
            if (channel && channel.unsubscribe) {
                window.addEventListener("beforeunload", () => channel.unsubscribe());
            }
        } catch (e) {
            console.warn("[CloudSync] realtime subscribe skipped", e);
        }
    }

    /* ---------- 初始化 ---------- */
    function init() {
        statusEl = document.getElementById("syncStatus");

        // 未开启：显示提示，直接退出
        if (!CFG || !CFG.enabled || !CFG.url || !CFG.anonKey || CFG.anonKey.indexOf("需填写") >= 0) {
            if (statusEl) setStatus("off", "☁ 未开启云同步");
            return;
        }
        if (!window.supabase || !window.supabase.createClient) {
            console.warn("[CloudSync] Supabase 客户端未加载");
            if (statusEl) setStatus("error", "⚠ 同步组件未加载");
            return;
        }
        try {
            client = window.supabase.createClient(CFG.url, CFG.anonKey);
        } catch (e) {
            console.warn("[CloudSync] createClient failed", e);
            if (statusEl) setStatus("error", "⚠ 配置错误");
            return;
        }
        ready = true;

        // 点击状态条 = 手动立即同步一次
        if (statusEl) statusEl.addEventListener("click", () => { if (ready) pull(); });

        // 先拉云端覆盖本地，再监听改动自动上传
        pull().then(() => {
            window.addEventListener("dw:dataChanged", push);
            subscribeRealtime();
        });
    }

    return { init };
})();
