/* =====================================================================
   cloud-sync.js — Supabase 云同步模块
   ---------------------------------------------------------------------
   作用：让生词库 / 待办 / 心情 在电脑、手机等多设备间自动同步，
        免去手动「导出 / 导入」。

   原理：
     - 所有设备读写 Supabase 中同一行（id = syncId）的 JSON 数据包
     - 打开页面先「拉取云端」覆盖本地，之后任意改动「防抖上传」
     - 合并策略：云端优先；但保留本地离线新增的项（不会互相覆盖）
     - 通过 Supabase Realtime 订阅，一端改动另一端约 1 秒内自动刷新

   关键健壮性设计（针对手机）：
     - 上传监听在 init 时「立即注册」，不等 pull 完成，避免早期改动丢失
     - 离开页面 / 切到后台时「尽力把待上传数据发出去」，规避手机节流
     - 云端为空且本地有数据时，「播种」本地数据到云端，避免首设备数据丢失
   ===================================================================== */

const CloudSync = (() => {
    const CFG = window.APP_CONFIG.supabase;
    const KEYS = window.APP_CONFIG.storageKeys;

    let client = null;
    let ready = false;
    let applyingRemote = false;   // 防止「应用云端数据」触发「上传云端」死循环
    let pushTimer = null;
    let statusEl = null;
    let cloudEmpty = true;        // 上次 pull 时云端是否为空（用于首设备播种）

    // 同步的用户数据：生词 / 待办 / 心情 / 首页布局
    const SYNC_KEYS = [KEYS.vocabulary, KEYS.todos, KEYS.moods, KEYS.homeLayout];

    /* ---------- 状态提示 ---------- */
    function setStatus(state, text) {
        if (!statusEl) return;
        statusEl.className = "sync-status sync-" + state;
        statusEl.textContent = text;
        statusEl.title = state === "error"
            ? "云同步失败，数据仍保存在本机；点击重试"
            : "点击可立即同步一次（拉取云端 + 上传本地）";
    }

    /* ---------- 收集本地数据 ---------- */
    function collectLocal() {
        const out = {};
        SYNC_KEYS.forEach(k => { out[k] = Api.store.get(k, null); });
        return out;
    }

    /* ---------- 本地是否有数据（用于播种判断） ---------- */
    function localHasData(local) {
        return SYNC_KEYS.some(k => {
            const v = local[k];
            return Array.isArray(v) ? v.length > 0 : (v && Object.keys(v).length > 0);
        });
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
        // 通知各模块重渲染（此时 applyingRemote 已复位）
        if (changed) {
            document.dispatchEvent(new CustomEvent("dw:dataChanged", { bubbles: true }));
            document.dispatchEvent(new CustomEvent("dw:remoteSynced", { bubbles: true }));
        }
    }

    /* ---------- 合并策略 ---------- */
    function mergeOne(key, local, remote) {
        if (key === KEYS.vocabulary)
            return mergeArray(local || [], remote || [], w => (w.word || "").toLowerCase());
        if (key === KEYS.todos)
            return mergeArray(local || [], remote || [], t => t.id);
        if (key === KEYS.moods)
            return mergeObject(local || {}, remote || {});
        if (key === KEYS.homeLayout)
            return remote;   // 布局偏好：last-write-wins（云端覆盖本地）
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
            if (statusEl) statusEl.classList.add("spin");
            setStatus("syncing", "☁ 同步中…");
            const { data, error } = await client
                .from("sync_data")
                .select("payload")
                .eq("id", CFG.syncId)
                .maybeSingle();
            if (error) { console.warn("[CloudSync] pull error", error); setStatus("error", "⚠ 同步失败"); return; }
            cloudEmpty = !data || !data.payload;
            if (data && data.payload) applyToLocal(data.payload);
            setStatus("ok", "☁ 已同步");
        } catch (e) {
            console.warn("[CloudSync] pull exception", e);
            setStatus("error", "⚠ 同步失败");
        } finally {
            if (statusEl) statusEl.classList.remove("spin");
        }
    }

    /* ---------- 上传云端 ---------- */
    async function doPush() {
        if (!ready || applyingRemote) return;
        try {
            if (statusEl) statusEl.classList.add("spin");
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
        } finally {
            if (statusEl) statusEl.classList.remove("spin");
        }
    }

    // 防抖触发上传（页面内正常改动走这里）
    function push() {
        if (!ready || applyingRemote) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(doPush, 400);
    }

    // 立即尽力上传（用于离开页面 / 切后台，不等定时器）
    function flush() {
        if (!ready || applyingRemote) return;
        clearTimeout(pushTimer);
        doPush();   // 不 await：尽力而为，留给浏览器把请求发出去
    }

    /* ---------- 首设备播种：云端为空且本地有数据，则上传本地 ---------- */
    function seedIfEmpty() {
        if (!ready) return;
        if (cloudEmpty) {
            const local = collectLocal();
            if (localHasData(local)) doPush();
        }
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

        // 立即注册上传监听（不等 pull 完成，避免早期改动丢失）
        // 注意：dw:dataChanged 由 api.js 派发在 document 上，故此处也监听 document
        document.addEventListener("dw:dataChanged", push);
        // 离开页面 / 切到后台前，尽力把待上传的数据发出去（解决手机节流丢数据）
        window.addEventListener("pagehide", flush);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") flush();
        });

        // 点击状态条 = 手动立即同步（拉取云端 + 播种本地）
        if (statusEl) statusEl.addEventListener("click", () => { pull().then(seedIfEmpty); });

        // 先拉云端覆盖本地；若云端为空且本地有数据，则把本地播种上去
        pull().then(seedIfEmpty);
        subscribeRealtime();
    }

    return { init };
})();
