/**
 * ZK User Memory Notebook (Char-only, Compatible) - Expanded Extraction
 * - Per-chat memory stored in chatMetadata (unique key)
 * - Inject via setExtensionPrompt (no chat mutation) -> less conflict with other extensions
 * - Char-only: lock ownerCharId on first use in this chat; only that character can read/learn
 * - Group chat injection OFF by default
 * - Visual notebook UI: view/edit/add/delete/import/export
 * - Expanded rule-based extraction: interests, wants, goals, habits, experiences (opt-in), skills, relationships, boundaries
 */

const ZKUM = {
  MODULE: "zkum_user_memory_char_only",
  PROMPT_KEY: "ZKUM_PROMPT_CHAR_ONLY",
  UI: { fabId: "zkum-fab", modalId: "zkum-modal", backdropId: "zkum-modal-backdrop" },
  DEFAULT_SETTINGS: Object.freeze({
    enabled: true,
    maxItems: 12,
    relevance: true,
    autoExtract: true,
    injectInGroups: false,
    depth: 1,
    showFab: true,

    // NEW: extraction knobs
    extractExperiences: false,     // default OFF (privacy-ish / risk of noisy one-off facts)
    minLen: 2,
    maxLen: 40
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

/** group detection */
function isGroupChat() {
  const c = ctx();
  return c.groupId !== undefined && c.groupId !== null;
}

/** per-chat store + lock ownerCharId */
function getStore() {
  const c = ctx();
  if (!c.chatMetadata[ZKUM.MODULE]) {
    c.chatMetadata[ZKUM.MODULE] = { version: 2, ownerCharId: null, facts: [], updatedAt: Date.now() };
  }
  const store = c.chatMetadata[ZKUM.MODULE];
  if (!Array.isArray(store.facts)) store.facts = [];

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

/** ---- helpers ---- */
function clipObj(obj) {
  const s = getSettings();
  let t = norm(obj).replace(/[。！？]$/, "");
  if (t.length < s.minLen) return "";
  if (t.length > s.maxLen) t = t.slice(0, s.maxLen) + "…";
  return t;
}

function makeFact(type, value, confidence, tags = []) {
  return {
    id: uid(),
    type,
    value,
    status: "active",
    confidence,
    tags,
    source: "",
    createdAt: nowISO(),
    lastSeenAt: nowISO(),
  };
}

/** ---- rule-based extraction ---- */
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
  const s = getSettings();
  const facts = [];

  // A) 喜好
  {
    const re = /(我|俺|本人)\s*(真的|很|超|非常|最)?\s*(喜歡|喜愛|愛|愛吃|偏好)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[4]);
      if (!obj) continue;
      facts.push(makeFact("preference_like", `使用者喜歡：${obj}`, 0.75, ["preference"]));
    }
  }

  // B) 不喜歡 / 雷點
  {
    const re = /(我|俺|本人)\s*(真的|很|超|非常|最)?\s*(不喜歡|討厭|不愛|雷)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[4]);
      if (!obj) continue;
      facts.push(makeFact("preference_dislike", `使用者不喜歡：${obj}`, 0.75, ["preference", "boundary"]));
    }
  }

  // C) 稱呼
  {
    const re = /(叫我|我叫|稱呼我|你可以叫我)\s*([^\s，。！？\n]{1,30})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const name = clipObj(m[2]);
      if (!name) continue;
      facts.push(makeFact("identity_name", `使用者希望被稱呼為：${name}`, 0.7, ["identity"]));
    }
  }

  // D) 興趣：我對X有興趣 / 我喜歡研究X / 我在學X / 我最近在看X
  {
    const re = /(我|俺|本人)\s*(對|在|最近在)?\s*(學|研究|玩|看|追|迷|喜歡研究|有興趣|很有興趣)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[4]);
      if (!obj) continue;
      // 避免跟“喜歡：X”重複太多
      facts.push(makeFact("interest", `使用者的興趣/在做：${obj}`, 0.65, ["interest"]));
    }
  }

  // E) 想要/想买/想得到：我想要X / 我想買X / 我想得到X
  {
    const re = /(我|俺|本人)\s*(很|超|非常)?\s*(想要|想買|想入手|想得到|想收到)\s*([^。！？\n]{1,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[4]);
      if (!obj) continue;
      facts.push(makeFact("want", `使用者想要：${obj}`, 0.7, ["want"]));
    }
  }

  // F) 计划/目标：我想…(做/學/去) / 我打算… / 我的目標是…
  {
    const re = /(我|俺|本人)\s*(打算|計畫|计划|想|準備|准备|目標是|目标是)\s*([^。！？\n]{2,80})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[3]);
      if (!obj) continue;
      // 排除“我想要X”已经在 want 捕到的情况（简单过滤）
      if (/(想要|想買|想入手|想得到|想收到)/.test(obj)) continue;
      facts.push(makeFact("goal_plan", `使用者的計畫/目標：${obj}`, 0.6, ["goal"]));
    }
  }

  // G) 习惯：我通常/經常/習慣… / 我每天…
  {
    const re = /(我|俺|本人)\s*(通常|經常|经常|習慣|习惯|每天|每週|每周)\s*([^。！？\n]{2,80})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[3]);
      if (!obj) continue;
      facts.push(makeFact("habit", `使用者的習慣：${obj}`, 0.6, ["habit"]));
    }
  }

  // H) 技能/擅长：我會X / 我擅長X / 我是X工程師
  {
    const re = /(我|俺|本人)\s*(會|会|擅長|擅长|熟悉|精通|是)\s*([^。！？\n]{2,80})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[3]);
      if (!obj) continue;
      // 避免把「我是/是」抓到太多垃圾：只保留帶“工程師/學生/老師/設計/工作”等的
      if (m[2] === "是" && !/(工程師|学生|學生|老師|设计|設計|工作|職業|职业|程序|程式|畫師|画师|作家|作者)/.test(obj)) continue;
      facts.push(makeFact("skill_role", `使用者的能力/身份線索：${obj}`, 0.55, ["identity", "skill"]));
    }
  }

  // I) 关系：我和X / 我有個X / 我朋友X（非常保守）
  {
    const re = /(我|俺|本人)\s*(有個|有个|有一個|有一个|和)\s*([^。！？\n]{2,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[3]);
      if (!obj) continue;
      if (!/(朋友|家人|爸|媽|父母|哥哥|姐姐|弟弟|妹妹|伴侶|伴侣|男友|女友|同事|同學|同学)/.test(obj)) continue;
      facts.push(makeFact("relationship", `使用者的人際/關係線索：${obj}`, 0.55, ["relationship"]));
    }
  }

  // J) 界线：不要/別… / 請別… / 不要提…
  {
    const re = /(不要|別|请别|請別|不要提|別提)\s*([^。！？\n]{2,60})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[0]);
      if (!obj) continue;
      facts.push(makeFact("boundary", `使用者界線：${obj}`, 0.65, ["boundary"]));
    }
  }

  // K) 经历（可选开关）：我以前… / 我曾經… / 我经历过…
  if (s.extractExperiences) {
    const re = /(我|俺|本人)\s*(以前|曾經|曾经|過去|经历过|經歷過)\s*([^。！？\n]{3,120})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const obj = clipObj(m[3]);
      if (!obj) continue;
      facts.push(makeFact("experience", `使用者經歷：${obj}`, 0.5, ["experience"]));
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
      existing.status = nf.status || existing.status;
      existing.tags = Array.from(new Set([...(existing.tags || []), ...(nf.tags || [])]));
    } else {
      store.facts.push(nf);
    }
  }
}

/** ---- relevance & injection ---- */
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
    const lastSeen = Date.parse(f.lastSeenAt || f.createdAt || nowISO());
    const ageDays = Math.max(0, (Date.now() - lastSeen) / (1000 * 60 * 60 * 24));
    const recency = Math.max(0, 10 - ageDays);
    const conf = Number(f.confidence || 0.5) * 5;
    return { f, score: hit * 2 + recency + conf };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxItems).map(x => x.f);
}

function buildInjectionText(store, lastUserText) {
  const s = getSettings();
  const chosen = pickFacts(store, lastUserText, s.maxItems, s.relevance);
  const lines = chosen.length ? chosen.map(f => `- ${f.value}`) : ["- （尚無）"];

  return [
    "【權限規則：以下內容是 {{char}} 的「私密內心筆記」，只能影響 {{char}} 的內心/決策/行動】",
    "- 世界書中的其他角色/NPC/旁白：一律視為「不知道」這些資訊",
    "- NPC 只能透過劇情中「{{char}} 明確告知 / 暴露線索 / 可觀察到的實際行動」獲得資訊",
    "- 當你寫 NPC 的台詞/行為時：必須忽略此筆記，不得讓 NPC 因此改變行為或說出相關內容",
    "- 若輸出包含多角色，請用清晰說話者標籤：",
    "  {{char}}：……",
    "  NPC(名字)：……",
    "  旁白：……",
    "",
    "【{{char}} 已知的使用者資訊（未列出 = 未知，禁止腦補）】",
    ...lines,
    "",
    "互動：{{char}} 可以自然運用（送禮、話題、稱呼等），但不要提到「插件/記憶系統」。",
  ].join("\n");
}

/** ---- setExtensionPrompt injection (no chat mutation) ---- */
function getInChatType() {
  const c = ctx();
  return (c.extension_prompt_types && (c.extension_prompt_types.IN_CHAT ?? c.extension_prompt_types.in_chat)) ?? 1;
}

function clearPrompt() {
  const c = ctx();
  if (typeof c.setExtensionPrompt !== "function") return;
  try {
    c.setExtensionPrompt(ZKUM.PROMPT_KEY, "", getInChatType(), getSettings().depth);
  } catch {}
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

  try {
    c.setExtensionPrompt(ZKUM.PROMPT_KEY, injection, getInChatType(), s.depth);
  } catch (e) {
    console.warn("[ZKUM] setExtensionPrompt failed:", e);
  }
}

/** ---- events ---- */
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
    refreshFabLabel();
    if (isModalOpen()) renderModal();
    applyPrompt();
  }
}

function onChatChanged() {
  refreshFabLabel();
  if (isModalOpen()) renderModal();
  applyPrompt();
}

/** ---- UI ---- */
function isModalOpen() {
  const m = document.getElementById(ZKUM.UI.modalId);
  return !!m && m.style.display === "block";
}

function mountUI() {
  const s = getSettings();

  let backdrop = document.getElementById(ZKUM.UI.backdropId);
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.id = ZKUM.UI.backdropId;
    backdrop.addEventListener("click", () => toggleModal(false));
    document.body.appendChild(backdrop);
  }

  let modal = document.getElementById(ZKUM.UI.modalId);
  if (!modal) {
    modal = document.createElement("div");
    modal.id = ZKUM.UI.modalId;
    modal.innerHTML = `
      <div class="zkum-header">
        <div>
          <div style="font-weight:700;">📝 角色記憶記事本（主 Char 專用）</div>
          <div class="zkum-small">可記：喜好、興趣、想要、目標、習慣…（經歷預設不自動抽取，可開啟）</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button id="zkum-close-btn" title="關閉">✕</button>
        </div>
      </div>

      <div class="zkum-body">
        <div class="zkum-actions">
          <button id="zkum-add-btn">＋新增</button>
          <button id="zkum-export-btn">匯出 JSON</button>
          <button id="zkum-import-btn">匯入 JSON</button>
          <button id="zkum-clear-btn" class="zkum-danger">清空本聊天記憶</button>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
          <label class="zkum-small"><input type="checkbox" id="zkum-enabled"> 啟用（注入記憶）</label>
          <label class="zkum-small"><input type="checkbox" id="zkum-autoExtract"> 自動抽取（規則）</label>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;">
          <label class="zkum-small">最大注入條目數
            <input type="number" id="zkum-maxItems" min="1" max="50">
          </label>
          <label class="zkum-small">注入深度（Depth）
            <input type="number" id="zkum-depth" min="0" max="20">
          </label>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;">
          <label class="zkum-small">只注入「相關」條目
            <select id="zkum-relevance">
              <option value="true">是（推薦）</option>
              <option value="false">否（注入最新 N 條）</option>
            </select>
          </label>
          <label class="zkum-small">群聊注入（不推薦）
            <select id="zkum-injectInGroups">
              <option value="false">關閉（推薦）</option>
              <option value="true">開啟</option>
            </select>
          </label>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;">
          <label class="zkum-small">自動抽取「經歷」（可選）
            <select id="zkum-extractExperiences">
              <option value="false">關閉（推薦）</option>
              <option value="true">開啟</option>
            </select>
          </label>
          <label class="zkum-small">單條最長字數
            <input type="number" id="zkum-maxLen" min="10" max="120">
          </label>
        </div>

        <div class="zkum-small" style="margin-top:10px;">
          ownerCharId：<span id="zkum-owner"></span>
          <br>目前角色可用：<span id="zkum-owner-ok"></span>
        </div>

        <div id="zkum-list" style="margin-top:10px;"></div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector("#zkum-close-btn").addEventListener("click", () => toggleModal(false));
    modal.querySelector("#zkum-add-btn").addEventListener("click", async () => {
      if (!isOwnerChar()) return;
      const store = getStore();
      store.facts.push({
        id: uid(),
        type: "other",
        value: "",
        confidence: 0.5,
        status: "active",
        tags: [],
        source: "",
        createdAt: nowISO(),
        lastSeenAt: nowISO(),
      });
      await saveStore();
      renderModal();
      refreshFabLabel();
      applyPrompt();
    });

    modal.querySelector("#zkum-export-btn").addEventListener("click", async () => exportJSON());
    modal.querySelector("#zkum-import-btn").addEventListener("click", async () => importJSON());
    modal.querySelector("#zkum-clear-btn").addEventListener("click", async () => {
      if (!isOwnerChar()) return;
      const store = getStore();
      store.facts = [];
      await saveStore();
      renderModal();
      refreshFabLabel();
      applyPrompt();
    });
  }

  let fab = document.getElementById(ZKUM.UI.fabId);
  if (!fab) {
    fab = document.createElement("div");
    fab.id = ZKUM.UI.fabId;
    fab.addEventListener("click", () => toggleModal(!isModalOpen()));
    document.body.appendChild(fab);
  }
  fab.style.display = s.showFab ? "block" : "none";
  refreshFabLabel();
}

function toggleModal(open) {
  const modal = document.getElementById(ZKUM.UI.modalId);
  const backdrop = document.getElementById(ZKUM.UI.backdropId);
  if (!modal || !backdrop) return;

  if (open) {
    backdrop.style.display = "block";
    modal.style.display = "block";
    renderModal();
  } else {
    backdrop.style.display = "none";
    modal.style.display = "none";
  }
}

function refreshFabLabel() {
  const fab = document.getElementById(ZKUM.UI.fabId);
  if (!fab) return;
  const store = getStore();
  const activeCount = (store.facts || []).filter(f => (f.status || "active") === "active" && norm(f.value)).length;
  fab.textContent = `📝記憶 (${activeCount})`;
  fab.title = "打開角色記憶記事本";
}

function renderModal() {
  const modal = document.getElementById(ZKUM.UI.modalId);
  if (!modal) return;

  const s = getSettings();
  const store = getStore();
  const list = modal.querySelector("#zkum-list");

  modal.querySelector("#zkum-owner").textContent = String(store.ownerCharId ?? "（未鎖定）");
  modal.querySelector("#zkum-owner-ok").textContent = isOwnerChar() ? "✅是（主 Char）" : "❌否（非主 Char 或群聊）";

  modal.querySelector("#zkum-enabled").checked = !!s.enabled;
  modal.querySelector("#zkum-autoExtract").checked = !!s.autoExtract;
  modal.querySelector("#zkum-maxItems").value = s.maxItems;
  modal.querySelector("#zkum-depth").value = s.depth;
  modal.querySelector("#zkum-relevance").value = String(!!s.relevance);
  modal.querySelector("#zkum-injectInGroups").value = String(!!s.injectInGroups);
  modal.querySelector("#zkum-extractExperiences").value = String(!!s.extractExperiences);
  modal.querySelector("#zkum-maxLen").value = Number(s.maxLen || 40);

  modal.querySelector("#zkum-enabled").onchange = (e) => { s.enabled = !!e.target.checked; saveSettings(); applyPrompt(); };
  modal.querySelector("#zkum-autoExtract").onchange = (e) => { s.autoExtract = !!e.target.checked; saveSettings(); };
  modal.querySelector("#zkum-maxItems").onchange = (e) => { s.maxItems = Math.max(1, Math.min(50, Number(e.target.value || 12))); saveSettings(); applyPrompt(); };
  modal.querySelector("#zkum-depth").onchange = (e) => { s.depth = Math.max(0, Math.min(20, Number(e.target.value || 1))); saveSettings(); applyPrompt(); };
  modal.querySelector("#zkum-relevance").onchange = (e) => { s.relevance = (String(e.target.value) === "true"); saveSettings(); applyPrompt(); };
  modal.querySelector("#zkum-injectInGroups").onchange = (e) => { s.injectInGroups = (String(e.target.value) === "true"); saveSettings(); applyPrompt(); };
  modal.querySelector("#zkum-extractExperiences").onchange = (e) => { s.extractExperiences = (String(e.target.value) === "true"); saveSettings(); };
  modal.querySelector("#zkum-maxLen").onchange = (e) => {
    s.maxLen = Math.max(10, Math.min(120, Number(e.target.value || 40)));
    saveSettings();
  };

  list.innerHTML = "";

  const facts = store.facts || [];
  if (!facts.length) {
    const empty = document.createElement("div");
    empty.className = "zkum-small";
    empty.textContent = "（目前沒有記憶。你可以按「＋新增」，或讓它從你的訊息自動抽取。）";
    list.appendChild(empty);
    return;
  }

  const editable = isOwnerChar();

  for (const f of facts) {
    const row = document.createElement("div");
    row.className = "zkum-row";

    const left = document.createElement("div");
    left.innerHTML = `
      <label class="zkum-small">類型
        <select data-k="type" ${editable ? "" : "disabled"}>
          <option value="preference_like">喜好</option>
          <option value="preference_dislike">不喜好</option>
          <option value="interest">興趣</option>
          <option value="want">想要</option>
          <option value="goal_plan">目標/計畫</option>
          <option value="habit">習慣</option>
          <option value="skill_role">技能/身份</option>
          <option value="relationship">關係</option>
          <option value="boundary">界線</option>
          <option value="experience">經歷</option>
          <option value="other">其他</option>
        </select>
      </label>

      <label class="zkum-small" style="margin-top:8px; display:block;">狀態
        <select data-k="status" ${editable ? "" : "disabled"}>
          <option value="active">active</option>
          <option value="inactive">inactive</option>
        </select>
      </label>

      <label class="zkum-small" style="margin-top:8px; display:block;">可信度（0~1）
        <input data-k="confidence" type="number" step="0.05" min="0" max="1" ${editable ? "" : "disabled"}>
      </label>

      <button class="zkum-danger" data-act="delete" style="margin-top:10px;" ${editable ? "" : "disabled"}>刪除此條</button>
    `;

    const right = document.createElement("div");
    right.innerHTML = `
      <label class="zkum-small">內容（{{char}} 會用這句互動）
        <textarea data-k="value" placeholder="例如：使用者的興趣/在做：繪畫" ${editable ? "" : "disabled"}></textarea>
      </label>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:8px;">
        <label class="zkum-small">tags（逗號）
          <input data-k="tags" placeholder="interest, art" ${editable ? "" : "disabled"}>
        </label>
        <label class="zkum-small">來源（可留空）
          <input data-k="source" placeholder="來源備註" ${editable ? "" : "disabled"}>
        </label>
      </div>

      <div class="zkum-small" style="margin-top:8px;">
        id: <span>${f.id}</span><br>
        created: <span>${f.createdAt || ""}</span><br>
        lastSeen: <span>${f.lastSeenAt || ""}</span>
      </div>
    `;

    row.appendChild(left);
    row.appendChild(right);
    list.appendChild(row);

    row.querySelector('[data-k="type"]').value = f.type || "other";
    row.querySelector('[data-k="status"]').value = f.status || "active";
    row.querySelector('[data-k="confidence"]').value = Number(f.confidence ?? 0.5);
    row.querySelector('[data-k="value"]').value = f.value || "";
    row.querySelector('[data-k="tags"]').value = Array.isArray(f.tags) ? f.tags.join(", ") : "";
    row.querySelector('[data-k="source"]').value = f.source || "";

    const onChange = async () => {
      if (!editable) return;
      f.type = row.querySelector('[data-k="type"]').value;
      f.status = row.querySelector('[data-k="status"]').value;
      f.confidence = Number(row.querySelector('[data-k="confidence"]').value || 0);
      f.value = norm(row.querySelector('[data-k="value"]').value);
      f.tags = norm(row.querySelector('[data-k="tags"]').value).split(",").map(norm).filter(Boolean);
      f.source = norm(row.querySelector('[data-k="source"]').value);
      f.lastSeenAt = nowISO();
      await saveStore();
      refreshFabLabel();
      applyPrompt();
    };

    row.querySelector('[data-k="type"]').onchange = onChange;
    row.querySelector('[data-k="status"]').onchange = onChange;
    row.querySelector('[data-k="confidence"]').onchange = onChange;
    row.querySelector('[data-k="value"]').oninput = debounce(onChange, 400);
    row.querySelector('[data-k="tags"]').oninput = debounce(onChange, 600);
    row.querySelector('[data-k="source"]').oninput = debounce(onChange, 600);

    row.querySelector('[data-act="delete"]').onclick = async () => {
      if (!editable) return;
      const store2 = getStore();
      store2.facts = (store2.facts || []).filter(x => x.id !== f.id);
      await saveStore();
      renderModal();
      refreshFabLabel();
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
    a.download = `zkum_memory_${Date.now()}.json`;
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
      renderModal();
      refreshFabLabel();
      applyPrompt();
    } catch (e) {
      console.warn(e);
      alert("匯入失敗：JSON 格式不對。");
    }
  };
  input.click();
}

/** init */
function init() {
  const c = ctx();
  const { eventSource, event_types } = c;

  eventSource.on(event_types.APP_READY, () => {
    mountUI();
    applyPrompt();
  });

  eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  eventSource.on(event_types.MESSAGE_SENT, onUserMessage);

  eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => applyPrompt());
  eventSource.on(event_types.GENERATION_ENDED, () => applyPrompt());
  eventSource.on(event_types.GENERATION_STOPPED, () => applyPrompt());

  try { mountUI(); } catch {}
}
init();
