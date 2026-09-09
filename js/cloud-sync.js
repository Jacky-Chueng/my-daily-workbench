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

    // 同步的用户数据：生词 / 待办 / 心情 / 首页布局 / 训练
    const SYNC_KEYS = [KEYS.vocabulary, KEYS.todos, KEYS.moods, KEYS.homeLayout, KEYS.fitness];

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
            return mergeGeneric(local || [], remote || [], w => (w.word || "").toLowerCase());
        if (key === KEYS.todos)
            return mergeTodos(local || [], remote || []);
        if (key === KEYS.moods)
            return mergeMoods(local || {}, remote || {});
        if (key === KEYS.fitness)
            return mergeFitness(local, remote);
        if (key === KEYS.homeLayout)
            return remote;   // 布局偏好：last-write-wins（云端覆盖本地）
        return remote;
    }

    /* 训练模块：分区合并
       - 目标 / 训练日：设置类，远端优先
       - 佳明数据 / 每日建议：比时间戳，晚的赢（由自动化在一台机器上写入）
       - 训练日志：按「日期 + 类型」union 去重，两端都不丢
       - 临时加练请求：本地 pending 优先保留，避免被旧数据覆盖导致请求丢失 */
    function mergeFitness(local, remote) {
        const l = local || {}, r = remote || {};
        const out = { ...l };
        if (r.goal !== undefined) out.goal = r.goal;
        if (r.trainingDays !== undefined) out.trainingDays = r.trainingDays;

        const ts2 = x => (x && (x.updatedAt || x.generatedAt || x.date ? (x.updatedAt || x.generatedAt || 0) : 0)) || 0;
        if (r.metrics !== undefined) out.metrics = ts2(r.metrics) >= ts2(l.metrics) ? r.metrics : l.metrics;
        if (r.advice !== undefined) out.advice = ts2(r.advice) >= ts2(l.advice) ? r.advice : l.advice;

        const logs = [...(l.logs || []), ...(r.logs || [])];
        const seen = new Map();
        logs.forEach(x => { if (x) seen.set(String(x.date) + "|" + String(x.type), x); });
        out.logs = Array.from(seen.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));

        if (l.adHoc && l.adHoc.status === "pending") {
            out.adHoc = (!r.adHoc || (r.adHoc.requestedAt || 0) < (l.adHoc.requestedAt || 0)) ? l.adHoc : r.adHoc;
        } else if (r.adHoc !== undefined) out.adHoc = r.adHoc;

        return out;
    }

    /* 取"更晚发生的那条"：所有增删改都会打 updatedAt 时间戳 */
    function ts(it) {
        return (it && (it.updatedAt || it.completedAt || 0)) || 0;
    }
    /* 两条冲突数据怎么取舍：
       墓碑（_deleted）优先 —— "删除"是最强意图，绝不能被另一台设备的旧副本复活；
       其余情况比时间戳，谁晚听谁的。 */
    function mergePair(a, b) {
        if (!a) return b;
        if (!b) return a;
        if (a._deleted && !b._deleted) return a;
        if (b._deleted && !a._deleted) return b;
        return ts(b) > ts(a) ? b : a;
    }

    // 通用数组：按 keyFn 分组，同组保留"更晚 / 已删除"的那条
    function mergeGeneric(localArr, remoteArr, keyFn) {
        const map = new Map();
        localArr.forEach(it => { if (it != null) map.set(keyFn(it), it); });
        remoteArr.forEach(it => {
            if (it == null) return;
            const k = keyFn(it);
            map.set(k, map.has(k) ? mergePair(map.get(k), it) : it);
        });
        return Array.from(map.values());
    }

    /* 待办专用：两轮合并
       第 1 轮按 id 合并 —— 正常情况（同一条两端 id 相同），勾选/编辑/删除都能同步。
       第 2 轮按「文本 + 创建时间」折叠 —— 兜住历史遗留问题：
         旧版本给没有 id 的旧数据"随机补 id"，两台电脑对同一条待办算出了不同 id，
         按 id 合并就永远对不上，于是删除（墓碑）传不过去、条目还越同步越多。
       内容指纹在任何设备上都相同，所以能把它们折叠成同一条。 */
    function mergeTodos(localArr, remoteArr) {
        const contentKey = t => (window.Todo && Todo.contentKey)
            ? Todo.contentKey(t)
            : (String((t && t.text) || "") + "|" + String((t && t.createdAt) || ""));

        const byId = mergeGeneric(localArr, remoteArr, t => String((t && t.id) || ""));

        const byContent = new Map();
        for (const it of byId) {
            if (it == null) continue;
            const k = contentKey(it);
            byContent.set(k, byContent.has(k) ? mergePair(byContent.get(k), it) : it);
        }
        return Array.from(byContent.values());
    }

    // 心情（按日期）：同键比时间戳；删除的用 _deletedAt，后发生的赢
    function mergeMoods(localObj, remoteObj) {
        const mts = x => (x && x._deleted)
            ? ((x._deletedAt || x.savedAt) || 0)
            : ((x && x.savedAt) || 0);
        const out = { ...localObj };
        Object.keys(remoteObj || {}).forEach(k => {
            const lv = localObj[k], rv = remoteObj[k];
            if (lv == null) { out[k] = rv; return; }
            out[k] = mts(rv) > mts(lv) ? rv : lv;
        });
        return out;
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
            const local = collectLocal();

            // 读云端再合并，再整体写回。
            // 直接 upsert 本地整包会把「本机没有的 key」抹掉——尤其新增 fitness 键时，
            // 另一台仍跑旧代码的设备一 push，就会把云端 fitness 清空。
            let payload = local;
            try {
                const { data } = await client
                    .from("sync_data")
                    .select("payload")
                    .eq("id", CFG.syncId)
                    .maybeSingle();
                if (data && data.payload) {
                    const remote = data.payload || {};
                    const merged = {};
                    SYNC_KEYS.forEach(k => {
                        merged[k] = mergeOne(k, local[k], remote[k]);
                    });
                    // 云端里有、但本机 SYNC_KEYS 不认识的其它键也原样保留
                    Object.keys(remote).forEach(k => {
                        if (!(k in merged)) merged[k] = remote[k];
                    });
                    payload = merged;
                }
            } catch (e) { /* 读云端失败就退化为直接推本地 */ }

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

    return { init, flushNow: flush };
})();
