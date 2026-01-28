/**
 * Char Knowledge - Extensions內嵌版（不覆蓋整個畫面）
 * - UI 顯示在「Extensions 設定頁」的可折疊區塊內
 * - 不用右下角浮動按鈕（避免被發送鍵擋住）
 * - 仍然：主Char鎖定(ownerCharId)、群聊預設不注入、不改聊天記錄、可增刪改
 */

const ZKUM = {
  MODULE: "zkum_user_memory_char_only",
  PROMPT_KEY: "ZKUM_PROMPT_CHAR_ONLY",
  SETTINGS_HTML_PATH: "/scripts/extensions/third-party/char-knowledge/settings.html",
  DEFAULT_SETTINGS: Object.freeze({
    enabled: true,
    maxItems: 12,
    relevance: true,
    autoExtract: true,
    injectInGroups: false,
    depth: 1,
  }),
};

function ctx() { return SillyTavern.getContext(); }
function norm(s) { return (s || "").toString().trim().replace(/\s+/g, " "); }
function uid() { return `m_${Date.now()}_${Math.random().toString(16).slice(2)}`; }
function nowISO() { return new Date().toISOString(); }
function debounce(fn, delay) { let t=null; return (...a)=>{clearTimeout(t); t=setTimeout(()=>fn(...a), delay);} }

function getSettings() {
  const c = ctx();
  if (!c.extensionSettings[ZKUM.MODULE]) c.extensionSettings[ZKUM.MODULE] = structuredClone(ZKUM.DEFAULT_SETTINGS);
  for (const k of Object.keys(ZKUM.DEFAULT_SETTINGS)) {
    if (!Object.hasOwn(c.extensionSettings[ZKUM.MODULE], k)) c.extensionSettings[ZKUM.MODULE][k] = ZKUM.DEFAULT_SETTINGS[k];
  }
  return c.extensionSettings[ZKUM.MODULE];
}
function saveSettings() {
  const c = ctx();
  if (typeof c.saveSettingsDebounced === "function") c.saveSettingsDebounced();
}

function isGroupChat() {
  const c = ctx();
  return c.groupId !== undefined && c.groupId !== null;
}

function getStore() {
  const c = ctx();
  if (!c.chatMetadata[ZKUM.MODULE]) {
    c.chatMetadata[ZKUM.MODULE] = { version: 2, ownerCharId: null, facts: [], updatedAt: Date.now() };
  }
  const store = c.chatMetadata[ZKUM.MODULE];
  if (!Array.isArray(store.facts)) store.facts = [];

  // lock owner (only in non-group)
  if (!isGroupChat() && store.ownerCharId == null && c.characterId !== undefined && c.characterId !== null) {
    store.ownerCharId = c.characterId;
  }
  return store;
}

function isOwnerChar() {
  const c = ctx();
  const store = getStore();
  if (isGroupChat()) return false;
  if (c.characterId === undefined || c.characterId === null) return false;
  return store.ownerCharId === c.characterId;
}

async function saveStore() {
  const c = ctx();
  const store = getStore();
  store.updatedAt = Date.now();
  if (typeof c.saveMetadata === "function") await c.saveMetadata();
}

/** ---- extraction（簡單示例：喜好/不喜歡/興趣/想要/稱呼）---- */
function makeFact(type, value, confidence, tags=[]) {
  return {
    id: uid(),
    type, value,
    status: "active",
    confidence,
    tags,
    source: "",
    createdAt: nowISO(),
    lastSeenAt: nowISO(),
  };
}

function dedupeFacts(facts) {
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const key = `${f.type}::${norm(f.value).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function extractFactsRuleBased(userText) {
  const text = norm(userText);
  if (!text) return [];
  const facts = [];

  // 喜好
  {
    const re = /(我|俺|本人)\s*(很|超|非常|最)?\s*(喜歡|喜愛|愛|偏好)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = norm(m[4]).replace(/[。！？]$/, "");
      if (!obj) continue;
      facts.push(makeFact("preference_like", `使用者喜歡：${obj}`, 0.75, ["preference"]));
    }
  }

  // 不喜歡
  {
    const re = /(我|俺|本人)\s*(很|超|非常|最)?\s*(不喜歡|討厭|不愛|雷)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = norm(m[4]).replace(/[。！？]$/, "");
      if (!obj) continue;
      facts.push(makeFact("preference_dislike", `使用者不喜歡：${obj}`, 0.75, ["boundary"]));
    }
  }

  // 興趣/在做
  {
    const re = /(我|俺|本人)\s*(最近在|在|對)?\s*(學|研究|玩|看|追|有興趣)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = norm(m[4]).replace(/[。！？]$/, "");
      if (!obj) continue;
      facts.push(makeFact("interest", `使用者的興趣/在做：${obj}`, 0.65, ["interest"]));
    }
  }

  // 想要
  {
    const re = /(我|俺|本人)\s*(很|超|非常)?\s*(想要|想買|想入手|想得到|想收到)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = norm(m[4]).replace(/[。！？]$/, "");
      if (!obj) continue;
      facts.push(makeFact("want", `使用者想要：${obj}`, 0.7, ["want"]));
    }
  }

  // 稱呼
  {
    const re = /(叫我|我叫|稱呼我|你可以叫我)\s*([^\s，。！？\n]{1,30})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = norm(m[2]).replace(/[。！？]$/, "");
      if (!name) continue;
      facts.push(makeFact("identity_name", `使用者希望被稱呼為：${name}`, 0.7, ["identity"]));
    }
  }

  return dedupeFacts(facts);
}

function upsertFacts(store, newFacts) {
  for (const nf of newFacts) {
    const key = `${nf.type}::${norm(nf.value).toLowerCase()}`;
    const existing = store.facts.find(f => `${f.type}::${norm(f.value).toLowerCase()}` === key);
    if (existing) {
      existing.lastSeenAt = nowISO();
      existing.confidence = Math.max(Number(existing.confidence || 0), Number(nf.confidence || 0));
      existing.tags = Array.from(new Set([...(existing.tags || []), ...(nf.tags || [])]));
    } else {
      store.facts.push(nf);
    }
  }
}

/** ---- injection（不改聊天記錄）---- */
function tokenize(s) {
  const t = norm(s).toLowerCase();
  const chars = [...t].filter(ch => ch.trim());
  const words = t.split(/[^a-z0-9\u4e00-\u9fff]+/g).filter(Boolean);
  return new Set([...chars, ...words]);
}

function pickFacts(store, lastUserText, maxItems, relevance) {
  const facts = (store.facts || []).filter(f => (f.status || "active") === "active" && norm(f.value));
  if (!relevance) return facts.slice(-maxItems);

  const q = tokenize(lastUserText || "");
  const scored = facts.map(f => {
    const v = tokenize(f.value || "");
    let hit = 0;
    for (const k of v) if (q.has(k)) hit += 1;
    const conf = Number(f.confidence || 0.5) * 5;
    return { f, score: hit * 2 + conf };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxItems).map(x => x.f);
}

function buildInjectionText(store, lastUserText) {
  const s = getSettings();
  const chosen = pickFacts(store, lastUserText, s.maxItems, s.relevance);
  const lines = chosen.length ? chosen.map(f => `- ${f.value}`) : ["- （尚無）"];
  return [
    "【權限：以下是 {{char}} 的私密內心筆記；NPC/旁白不得直接知道】",
    "【{{char}} 已知的使用者資訊（未列出=未知）】",
    ...lines,
  ].join("\n");
}

function getInChatType() {
  const c = ctx();
  return (c.extension_prompt_types && (c.extension_prompt_types.IN_CHAT ?? c.extension_prompt_types.in_chat)) ?? 1;
}

function clearPrompt() {
  const c = ctx();
  if (typeof c.setExtensionPrompt !== "function") return;
  try { c.setExtensionPrompt(ZKUM.PROMPT_KEY, "", getInChatType(), getSettings().depth); } catch {}
}

function applyPrompt() {
  const s = getSettings();
  const c = ctx();
  if (!s.enabled) { clearPrompt(); return; }
  if (typeof c.setExtensionPrompt !== "function") return;

  if (isGroupChat() && !s.injectInGroups) { clearPrompt(); return; }
  if (!isOwnerChar()) { clearPrompt(); return; }

  const store = getStore();
  const lastUser = [...(c.chat || [])].reverse().find(m => m?.is_user);
  const injection = buildInjectionText(store, lastUser?.mes || "");
  try { c.setExtensionPrompt(ZKUM.PROMPT_KEY, injection, getInChatType(), s.depth); } catch {}
}

/** ---- Extensions 設定頁內嵌 UI ---- */
async function mountSettingsPanel() {
  if (document.getElementById("zkum-settings-root")) return;

  let html = "";
  try {
    const res = await fetch(ZKUM.SETTINGS_HTML_PATH);
    html = await res.text();
  } catch (e) {
    console.warn("[ZKUM] settings.html load failed:", e);
    return;
  }

  // ST 各版本容器 id 可能不同，找得到就塞進去
  const container =
    document.querySelector("#extensions_settings") ||
    document.querySelector("#extensions_settings_container") ||
    document.querySelector("#extensions_settings_block") ||
    document.body;

  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  container.appendChild(wrap);

  bindSettingsUI();
  renderSettingsUI();
}

function bindSettingsUI() {
  const addBtn = document.getElementById("zkum-add");
  const exportBtn = document.getElementById("zkum-export");
  const importBtn = document.getElementById("zkum-import");
  const clearBtn = document.getElementById("zkum-clear");

  const enabled = document.getElementById("zkum-enabled");
  const autoExtract = document.getElementById("zkum-autoExtract");
  const maxItems = document.getElementById("zkum-maxItems");
  const depth = document.getElementById("zkum-depth");
  const relevance = document.getElementById("zkum-relevance");
  const injectInGroups = document.getElementById("zkum-injectInGroups");

  if (addBtn) addBtn.onclick = async () => {
    if (!isOwnerChar()) return;
    const store = getStore();
    store.facts.push(makeFact("other", "", 0.5, []));
    await saveStore();
    renderSettingsUI();
    applyPrompt();
  };

  if (clearBtn) clearBtn.onclick = async () => {
    if (!isOwnerChar()) return;
    const store = getStore();
    store.facts = [];
    await saveStore();
    renderSettingsUI();
    applyPrompt();
  };

  if (exportBtn) exportBtn.onclick = async () => exportJSON();
  if (importBtn) importBtn.onclick = async () => importJSON();

  if (enabled) enabled.onchange = (e) => { getSettings().enabled = !!e.target.checked; saveSettings(); applyPrompt(); renderSettingsUI(); };
  if (autoExtract) autoExtract.onchange = (e) => { getSettings().autoExtract = !!e.target.checked; saveSettings(); };
  if (maxItems) maxItems.onchange = (e) => { getSettings().maxItems = Math.max(1, Math.min(50, Number(e.target.value||12))); saveSettings(); applyPrompt(); };
  if (depth) depth.onchange = (e) => { getSettings().depth = Math.max(0, Math.min(20, Number(e.target.value||1))); saveSettings(); applyPrompt(); };
  if (relevance) relevance.onchange = (e) => { getSettings().relevance = (String(e.target.value)==="true"); saveSettings(); applyPrompt(); };
  if (injectInGroups) injectInGroups.onchange = (e) => { getSettings().injectInGroups = (String(e.target.value)==="true"); saveSettings(); applyPrompt(); renderSettingsUI(); };
}

function renderSettingsUI() {
  const s = getSettings();
  const store = getStore();

  const owner = document.getElementById("zkum-owner");
  const ownerOk = document.getElementById("zkum-owner-ok");
  if (owner) owner.textContent = String(store.ownerCharId ?? "（未鎖定）");
  if (ownerOk) ownerOk.textContent = isOwnerChar() ? "✅是（主 Char）" : "❌否（非主 Char 或群聊）";

  const enabled = document.getElementById("zkum-enabled");
  const autoExtract = document.getElementById("zkum-autoExtract");
  const maxItems = document.getElementById("zkum-maxItems");
  const depth = document.getElementById("zkum-depth");
  const relevance = document.getElementById("zkum-relevance");
  const injectInGroups = document.getElementById("zkum-injectInGroups");

  if (enabled) enabled.checked = !!s.enabled;
  if (autoExtract) autoExtract.checked = !!s.autoExtract;
  if (maxItems) maxItems.value = s.maxItems;
  if (depth) depth.value = s.depth;
  if (relevance) relevance.value = String(!!s.relevance);
  if (injectInGroups) injectInGroups.value = String(!!s.injectInGroups);

  const list = document.getElementById("zkum-list");
  if (!list) return;

  list.innerHTML = "";
  const facts = store.facts || [];
  const editable = isOwnerChar();

  if (!facts.length) {
    const div = document.createElement("div");
    div.style.opacity = "0.85";
    div.style.fontSize = "12px";
    div.textContent = "（目前沒有記憶。你可以按「＋新增」，或讓它從你的訊息自動抽取。）";
    list.appendChild(div);
    return;
  }

  for (const f of facts) {
    const row = document.createElement("div");
    row.style.border = "1px solid rgba(255,255,255,.12)";
    row.style.borderRadius = "12px";
    row.style.padding = "10px";
    row.style.margin = "10px 0";

    row.innerHTML = `
      <div style="display:grid;grid-template-columns:120px 1fr;gap:10px;">
        <div>
          <div style="font-size:12px;opacity:.85;">類型</div>
          <select data-k="type" ${editable ? "" : "disabled"} style="width:100%;">
            <option value="preference_like">喜好</option>
            <option value="preference_dislike">不喜好</option>
            <option value="interest">興趣</option>
            <option value="want">想要</option>
            <option value="identity_name">稱呼</option>
            <option value="other">其他</option>
          </select>

          <div style="font-size:12px;opacity:.85;margin-top:8px;">狀態</div>
          <select data-k="status" ${editable ? "" : "disabled"} style="width:100%;">
            <option value="active">active</option>
            <option value="inactive">inactive</option>
          </select>

          <button data-act="delete" ${editable ? "" : "disabled"}
            style="margin-top:10px;width:100%;border:1px solid rgba(255,120,120,.35);background:rgba(255,120,120,.12);border-radius:999px;padding:6px;cursor:pointer;">
            刪除
          </button>
        </div>

        <div>
          <div style="font-size:12px;opacity:.85;">內容（{{char}} 會用）</div>
          <textarea data-k="value" ${editable ? "" : "disabled"} style="width:100%;min-height:56px;">${f.value || ""}</textarea>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;">
            <div>
              <div style="font-size:12px;opacity:.85;">tags（逗號）</div>
              <input data-k="tags" ${editable ? "" : "disabled"} style="width:100%;" value="${Array.isArray(f.tags)?f.tags.join(", "):""}">
            </div>
            <div>
              <div style="font-size:12px;opacity:.85;">可信度</div>
              <input data-k="confidence" ${editable ? "" : "disabled"} type="number" min="0" max="1" step="0.05" style="width:100%;" value="${Number(f.confidence ?? 0.5)}">
            </div>
          </div>

          <div style="font-size:12px;opacity:.75;margin-top:8px;">
            id: ${f.id}
          </div>
        </div>
      </div>
    `;

    list.appendChild(row);

    row.querySelector('[data-k="type"]').value = f.type || "other";
    row.querySelector('[data-k="status"]').value = f.status || "active";

    const onChange = async () => {
      if (!editable) return;
      f.type = row.querySelector('[data-k="type"]').value;
      f.status = row.querySelector('[data-k="status"]').value;
      f.value = norm(row.querySelector('[data-k="value"]').value);
      f.tags = norm(row.querySelector('[data-k="tags"]').value).split(",").map(norm).filter(Boolean);
      f.confidence = Number(row.querySelector('[data-k="confidence"]').value || 0.5);
      f.lastSeenAt = nowISO();
      await saveStore();
      applyPrompt();
    };

    row.querySelector('[data-k="type"]').onchange = onChange;
    row.querySelector('[data-k="status"]').onchange = onChange;
    row.querySelector('[data-k="confidence"]').onchange = onChange;
    row.querySelector('[data-k="value"]').oninput = debounce(onChange, 400);
    row.querySelector('[data-k="tags"]').oninput = debounce(onChange, 600);

    row.querySelector('[data-act="delete"]').onclick = async () => {
      if (!editable) return;
      const store2 = getStore();
      store2.facts = (store2.facts || []).filter(x => x.id !== f.id);
      await saveStore();
      renderSettingsUI();
      applyPrompt();
    };
  }
}

/** export/import */
async function exportJSON() {
  const store = getStore();
  const payload = JSON.stringify(store, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    const blob = new Blob([payload], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `char_knowledge_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    console.log(payload);
    alert("匯出失敗（剪貼簿被阻擋）。已輸出到 Console。");
  }
}

async function importJSON() {
  if (!isOwnerChar()) return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.facts)) throw new Error("invalid format");
      const store = getStore();
      store.facts = parsed.facts.map(x => ({
        id: x.id || uid(),
        type: x.type || "other",
        value: norm(x.value),
        confidence: Number(x.confidence ?? 0.5),
        status: x.status || "active",
        tags: Array.isArray(x.tags) ? x.tags.map(norm).filter(Boolean) : [],
        source: norm(x.source || ""),
        createdAt: x.createdAt || nowISO(),
        lastSeenAt: x.lastSeenAt || nowISO(),
      }));
      await saveStore();
      renderSettingsUI();
      applyPrompt();
    } catch (e) {
      console.warn(e);
      alert("匯入失敗：JSON 格式不對。");
    }
  };
  input.click();
}

/** events */
async function onUserMessage(data) {
  const s = getSettings();
  if (!s.enabled || !s.autoExtract) return;
  if (!isOwnerChar()) return;

  const text = data?.message ?? data?.mes ?? "";
  if (!norm(text)) return;

  const store = getStore();
  const facts = extractFactsRuleBased(text);
  if (facts.length) {
    upsertFacts(store, facts);
    await saveStore();
    renderSettingsUI();
    applyPrompt();
  }
}

function onChatChanged() {
  renderSettingsUI();
  applyPrompt();
}

/** init */
function init() {
  const c = ctx();
  const { eventSource, event_types } = c;

  eventSource.on(event_types.APP_READY, async () => {
    await mountSettingsPanel();
    applyPrompt();
  });

  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  eventSource.on(event_types.MESSAGE_SENT, onUserMessage);
  eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => applyPrompt());
  eventSource.on(event_types.GENERATION_ENDED, () => applyPrompt());
  eventSource.on(event_types.GENERATION_STOPPED, () => applyPrompt());
}
init();
