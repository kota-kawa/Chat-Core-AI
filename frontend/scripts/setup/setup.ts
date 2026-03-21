/**
 * setup.ts
 *
 * ■ タスクカードの取得・表示 (loadTaskCards)
 *   - /api/tasks からタスク一覧を取得し、.prompt-card を動的生成
 *   - カード下向きアイコンでタスク詳細モーダル（プロンプトテンプレート／入出力例）を表示
 *
 * ■ セットアップ画面切替 (showSetupForm)
 *   - チャット画面を隠し、セットアップ画面を再表示
 *
 * ■ タスク選択でチャット開始 (handleTaskCardClick)
 *   - 「状況・作業環境」入力＋カードクリックで新規チャットルーム作成
 *   - 最初のメッセージを Bot に投げてチャットを開始
 *
 * ■ 「もっと見る」折り畳み機能 (initToggleTasks)
 *   - タスクが 6 件超えると 7 件目以降を折り畳み、展開／折り畳みボタンを生成
 */
import defaultTasks from "../../data/default_tasks.json";

type TaskItem = {
  name?: string;
  prompt_template?: string;
  response_rules?: string;
  output_skeleton?: string;
  input_examples?: string;
  output_examples?: string;
  is_default?: boolean;
};

let isTaskLaunchInProgress = false;

const AUTH_STATE_CACHE_KEY = "chatcore.auth.loggedIn";
const TASKS_CACHE_KEY_PREFIX = "chatcore.tasks.v2.";
const TASKS_CACHE_TTL_MS = 30_000;
const SETUP_FIT_COMPACT_CLASS = "setup-fit-compact";
const SETUP_FIT_TIGHT_CLASS = "setup-fit-tight";

let setupFitRafId: number | null = null;

type TaskCachePayload = {
  cachedAt: number;
  tasks: TaskItem[];
};

type LoadTaskCardsOptions = {
  forceRefresh?: boolean;
};

function applySetupViewportFit() {
  const setupContainer = document.getElementById("setup-container");
  const shell = document.querySelector<HTMLElement>(".chat-page-shell");
  if (!setupContainer || !shell) return;

  // セットアップ画面非表示時は密度調整クラスを解除しておく
  if (setupContainer.style.display === "none") {
    setupContainer.classList.remove(SETUP_FIT_COMPACT_CLASS, SETUP_FIT_TIGHT_CLASS);
    return;
  }

  setupContainer.classList.remove(SETUP_FIT_COMPACT_CLASS, SETUP_FIT_TIGHT_CLASS);

  const shellStyles = window.getComputedStyle(shell);
  const shellPaddingTop = Number.parseFloat(shellStyles.paddingTop) || 0;
  const shellPaddingBottom = Number.parseFloat(shellStyles.paddingBottom) || 0;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const availableHeight = Math.max(0, viewportHeight - shellPaddingTop - shellPaddingBottom);

  if (setupContainer.getBoundingClientRect().height <= availableHeight + 1) return;

  setupContainer.classList.add(SETUP_FIT_COMPACT_CLASS);
  if (setupContainer.getBoundingClientRect().height <= availableHeight + 1) return;

  setupContainer.classList.add(SETUP_FIT_TIGHT_CLASS);
}

function scheduleSetupViewportFit() {
  if (setupFitRafId !== null) {
    window.cancelAnimationFrame(setupFitRafId);
  }
  setupFitRafId = window.requestAnimationFrame(() => {
    setupFitRafId = null;
    applySetupViewportFit();
  });
}

window.addEventListener("resize", scheduleSetupViewportFit);
window.visualViewport?.addEventListener("resize", scheduleSetupViewportFit);
document.addEventListener("authstatechange", scheduleSetupViewportFit);

function getTasksCacheKey() {
  let scope = "guest";
  try {
    if (localStorage.getItem(AUTH_STATE_CACHE_KEY) === "1") {
      scope = "auth";
    }
  } catch {
    // localStorage が使えない環境では guest スコープを使用
  }
  return `${TASKS_CACHE_KEY_PREFIX}${scope}`;
}

function readCachedTasks() {
  try {
    const raw = localStorage.getItem(getTasksCacheKey());
    if (!raw) return null;
    const payload = JSON.parse(raw) as TaskCachePayload;
    if (!payload || !Array.isArray(payload.tasks) || typeof payload.cachedAt !== "number") {
      return null;
    }
    if (Date.now() - payload.cachedAt > TASKS_CACHE_TTL_MS) {
      return null;
    }
    return payload.tasks;
  } catch {
    return null;
  }
}

function writeCachedTasks(tasks: TaskItem[]) {
  try {
    const payload: TaskCachePayload = {
      cachedAt: Date.now(),
      tasks
    };
    localStorage.setItem(getTasksCacheKey(), JSON.stringify(payload));
  } catch {
    // localStorage が使えない環境では保存をスキップ
  }
}

function invalidateTasksCache() {
  try {
    localStorage.removeItem(`${TASKS_CACHE_KEY_PREFIX}guest`);
    localStorage.removeItem(`${TASKS_CACHE_KEY_PREFIX}auth`);
  } catch {
    // localStorage が使えない環境では削除をスキップ
  }
}

// ▼ 1. タスクカード生成・詳細表示 -------------------------------------------------
function getFallbackTasks() {
  return (defaultTasks as TaskItem[]).map((task) => ({
    ...task,
    is_default: true
  }));
}

function escapeHtml(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatMultilineHtml(value: unknown) {
  return escapeHtml(value).replace(/\r\n|\r|\n/g, "<br>");
}

function normalizeTask(task: TaskItem | null | undefined) {
  if (!task) {
    return {
      name: "",
      prompt_template: "",
      response_rules: "",
      output_skeleton: "",
      input_examples: "",
      output_examples: "",
      is_default: false
    };
  }

  return {
    name: task.name ? String(task.name).trim() : "",
    prompt_template: task.prompt_template ? String(task.prompt_template) : "",
    response_rules: task.response_rules ? String(task.response_rules) : "",
    output_skeleton: task.output_skeleton ? String(task.output_skeleton) : "",
    input_examples: task.input_examples ? String(task.input_examples) : "",
    output_examples: task.output_examples ? String(task.output_examples) : "",
    is_default: Boolean(task.is_default)
  };
}

function createTaskSignature(tasks: TaskItem[]) {
  if (!Array.isArray(tasks) || tasks.length === 0) return "__empty__";
  return tasks
    .map((task) => {
      const normalized = normalizeTask(task);
      return [
        normalized.name,
        normalized.prompt_template,
        normalized.response_rules,
        normalized.output_skeleton,
        normalized.input_examples,
        normalized.output_examples,
        normalized.is_default ? "1" : "0"
      ].join("\u001f");
    })
    .join("\u001e");
}

function hydrateSSRTaskCards() {
  const container = document.getElementById("task-selection");
  if (!container || container.dataset.tasksSignature) return;

  const hasSSRTaskCards = container.querySelector(".task-wrapper .prompt-card") !== null;
  if (!hasSSRTaskCards) return;

  // SSR で描画済みのデフォルトカードを初期状態として採用し、初回再描画を避ける
  container.dataset.tasksSignature = createTaskSignature(getFallbackTasks());
  initSetupTaskCards();
  initToggleTasks();
  if (typeof window.initTaskOrderEditing === "function") window.initTaskOrderEditing();
  scheduleSetupViewportFit();
}

function initAiModelSelect() {
  const nativeSelect = document.getElementById("ai-model") as HTMLSelectElement | null;
  if (!nativeSelect) return;
  if (nativeSelect.dataset.modernSelectInitialized === "true") return;

  nativeSelect.dataset.modernSelectInitialized = "true";
  nativeSelect.classList.add("model-select-native");

  const wrapper = document.createElement("div");
  wrapper.className = "model-select";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "model-select-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const menu = document.createElement("div");
  menu.className = "model-select-menu";
  menu.setAttribute("role", "listbox");

  const closeMenu = () => {
    wrapper.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    wrapper.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
  };

  const syncFromSelect = () => {
    const selected = nativeSelect.options[nativeSelect.selectedIndex];
    trigger.textContent = selected?.textContent?.trim() || "";

    menu.querySelectorAll<HTMLButtonElement>(".model-select-option").forEach((optionButton) => {
      const isSelected = optionButton.dataset.value === nativeSelect.value;
      optionButton.classList.toggle("is-selected", isSelected);
      optionButton.setAttribute("aria-selected", isSelected ? "true" : "false");
    });
  };

  [...nativeSelect.options].forEach((option) => {
    const optionButton = document.createElement("button");
    optionButton.type = "button";
    optionButton.className = "model-select-option";
    optionButton.setAttribute("role", "option");
    optionButton.dataset.value = option.value;
    optionButton.textContent = option.textContent || option.value;

    optionButton.addEventListener("click", (e) => {
      e.preventDefault();
      if (nativeSelect.value !== option.value) {
        nativeSelect.value = option.value;
        nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
      closeMenu();
    });

    menu.appendChild(optionButton);
  });

  trigger.addEventListener("click", (e) => {
    e.preventDefault();
    if (wrapper.classList.contains("is-open")) {
      closeMenu();
    } else {
      openMenu();
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openMenu();
    }
    if (e.key === "Escape") {
      closeMenu();
    }
  });

  document.addEventListener("click", (e) => {
    const target = e.target as Node | null;
    if (!target) return;
    if (!wrapper.contains(target)) {
      closeMenu();
    }
  });

  nativeSelect.addEventListener("change", syncFromSelect);

  wrapper.append(trigger, menu);
  nativeSelect.insertAdjacentElement("afterend", wrapper);
  syncFromSelect();
}

function loadTaskCards(options: LoadTaskCardsOptions = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const ioModal = document.getElementById("io-modal");
  const ioModalContent = document.getElementById("io-modal-content");
  const taskSelection = document.getElementById("task-selection");

  // モーダルを閉じるヘルパ
  function closeIOModal() {
    if (!ioModal) return;
    ioModal.style.display = "none";
    ioModal.setAttribute("aria-hidden", "true");
  }

  if (ioModal && ioModalContent && !ioModal.dataset.bound) {
    ioModal.dataset.bound = "true";
    ioModal.setAttribute("aria-hidden", "true");
    // 背景クリック or 閉じるボタン押下でモーダルを閉じる
    ioModal.addEventListener(
      "click",
      (e) => {
        const target = e.target as Element | null;
        if (!target) return;
        if (target === ioModal || target.closest("[data-close-task-detail]")) {
          closeIOModal();
        }
      },
      true
    );
    // 内部クリックでは閉じない
    ioModalContent.addEventListener("click", (e) => e.stopPropagation());
    // ESC キーで閉じる
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (ioModal.style.display === "none") return;
      closeIOModal();
    });
  }

  const openTaskDetailModal = (card: HTMLElement) => {
    if (!ioModal || !ioModalContent) return;
    const safeTask = formatMultilineHtml(card.dataset.task || "タスク名がありません");
    const safePromptTemplate = formatMultilineHtml(card.dataset.prompt_template || "プロンプトテンプレートはありません");
    const responseRules = (card.dataset.response_rules || "").trim();
    const outputSkeleton = (card.dataset.output_skeleton || "").trim();
    const inputExamples = (card.dataset.input_examples || "").trim();
    const outputExamples = (card.dataset.output_examples || "").trim();
    const detailSections = [
      `
        <section class="task-detail-section">
          <h6 class="task-detail-section-title">タスク名</h6>
          <div class="task-detail-section-body task-detail-section-body-compact">${safeTask}</div>
        </section>
      `,
      `
        <section class="task-detail-section">
          <h6 class="task-detail-section-title">プロンプトテンプレート</h6>
          <div class="task-detail-section-body">${safePromptTemplate}</div>
        </section>
      `
    ];

    if (responseRules) {
      detailSections.push(`
        <section class="task-detail-section">
          <h6 class="task-detail-section-title">回答ルール</h6>
          <div class="task-detail-section-body">${formatMultilineHtml(responseRules)}</div>
        </section>
      `);
    }

    if (outputSkeleton) {
      detailSections.push(`
        <section class="task-detail-section">
          <h6 class="task-detail-section-title">出力テンプレート</h6>
          <div class="task-detail-section-body">${formatMultilineHtml(outputSkeleton)}</div>
        </section>
      `);
    }

    if (inputExamples) {
      detailSections.push(`
        <section class="task-detail-section">
          <h6 class="task-detail-section-title">入力例</h6>
          <div class="task-detail-section-body">${formatMultilineHtml(inputExamples)}</div>
        </section>
      `);
    }

    if (outputExamples) {
      detailSections.push(`
        <section class="task-detail-section">
          <h6 class="task-detail-section-title">出力例</h6>
          <div class="task-detail-section-body">${formatMultilineHtml(outputExamples)}</div>
        </section>
      `);
    }

    if (!responseRules && !outputSkeleton && !inputExamples && !outputExamples) {
      detailSections.push(`
        <section class="task-detail-section">
          <h6 class="task-detail-section-title">補助情報</h6>
          <div class="task-detail-section-body">追加の回答ルールや例は設定されていません。</div>
        </section>
      `);
    }

    ioModalContent.innerHTML = `
      <div class="task-detail-modal-shell">
        <div class="task-detail-modal-header">
          <div>
            <p class="task-detail-modal-eyebrow">Task Detail</p>
            <h5 class="task-detail-modal-title" id="taskDetailTitle">タスク詳細</h5>
          </div>
          <button type="button" class="task-detail-modal-close" data-close-task-detail aria-label="タスク詳細を閉じる">
            <i class="bi bi-x-lg"></i>
          </button>
        </div>
        <div class="task-detail-sections">
          ${detailSections.join("")}
        </div>
      </div>`;
    ioModal.style.display = "flex";
    ioModal.setAttribute("aria-hidden", "false");
    ioModal.focus();
  };

  if (taskSelection && !taskSelection.dataset.detailBound) {
    taskSelection.dataset.detailBound = "true";
    taskSelection.addEventListener("click", (e) => {
      const target = e.target as Element | null;
      const detailButton = target?.closest(".task-detail-toggle");
      if (!detailButton) return;
      e.preventDefault();
      e.stopPropagation();
      const card = detailButton.closest(".prompt-card") as HTMLElement | null;
      if (!card) return;
      openTaskDetailModal(card);
    });
  }

  const renderTaskCards = (tasks: TaskItem[]) => {
    const container = document.getElementById("task-selection");
    if (!container) return;
    const signature = createTaskSignature(tasks);

    // 同一内容の再描画は避け、遅延後の「全体再表示」を抑える
    if (container.dataset.tasksSignature === signature) return;
    container.dataset.tasksSignature = signature;

    // コンテナをクリア
    container.innerHTML = "";

    // タスクが空の場合はメッセージを表示
    if (!tasks || tasks.length === 0) {
      container.innerHTML = "<p>タスクが見つかりませんでした。</p>";
      return;
    }

    tasks.forEach((task) => {
      // task自体がnull/undefinedの場合はスキップ（念のため）
      if (!task) return;

      const taskName =
        typeof task.name === "string" && task.name.trim()
          ? task.name.trim()
          : task.name
            ? String(task.name)
            : "無題";

      // ラッパー
      const wrapper = document.createElement("div");
      wrapper.className = "task-wrapper";

      // カード
      const card = document.createElement("div");
      card.className = "prompt-card";
      card.dataset.task = taskName;
      card.dataset.prompt_template = task.prompt_template || "プロンプトテンプレートはありません";
      card.dataset.response_rules = task.response_rules || "";
      card.dataset.output_skeleton = task.output_skeleton || "";
      card.dataset.input_examples = task.input_examples || "";
      card.dataset.output_examples = task.output_examples || "";
      card.dataset.is_default = task.is_default ? "true" : "false";

      // ヘッダー（タイトル＋▼ボタン）
      const headerContainer = document.createElement("div");
      headerContainer.className = "header-container";

      const header = document.createElement("div");
      header.className = "task-header";
      header.textContent = taskName;

      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.classList.add("btn", "btn-outline-success", "btn-md", "task-detail-toggle");
      toggleBtn.innerHTML = '<i class="bi bi-caret-down"></i>';

      headerContainer.append(header, toggleBtn);
      card.appendChild(headerContainer);
      wrapper.appendChild(card);
      container.appendChild(wrapper);
    });

    // クリック／並び替え関係の初期化
    initSetupTaskCards();
    initToggleTasks();
    if (typeof window.initTaskOrderEditing === "function") window.initTaskOrderEditing();
    scheduleSetupViewportFit();
  };

  const applyTasks = (tasks: TaskItem[]) => {
    // タスクが空、もしくは配列でない場合はフォールバックを表示
    if (!Array.isArray(tasks) || tasks.length === 0) {
      renderTaskCards(getFallbackTasks());
      return;
    }
    renderTaskCards(tasks);
  };

  hydrateSSRTaskCards();

  if (!forceRefresh) {
    const cachedTasks = readCachedTasks();
    if (Array.isArray(cachedTasks) && cachedTasks.length > 0) {
      applyTasks(cachedTasks);
      return;
    }
  }

  // 初期ロード時: まずはフォールバックを表示しておく
  renderTaskCards(getFallbackTasks());

  // /api/tasks から取得
  fetch("/api/tasks")
    .then((r) => {
      const contentType = r.headers.get("content-type") || "";
      if (!r.ok) {
        throw new Error(`tasks fetch failed: ${r.status}`);
      }
      if (!contentType.includes("application/json")) {
        throw new Error("tasks response is not json");
      }
      return r.json();
    })
    .then((data) => {
      const tasks: TaskItem[] = Array.isArray(data?.tasks) ? data.tasks : [];
      if (tasks.length > 0) {
        writeCachedTasks(tasks);
      }
      applyTasks(tasks);
    })
    .catch((err) => {
      console.error("タスク読み込みに失敗:", err);
      // エラー時もフォールバックを表示
      applyTasks([]);
    });
}

// ▼ 2. セットアップ画面の表示 ------------------------------------------------------
function showSetupForm() {
  const chatContainer = document.getElementById("chat-container");
  const setupContainer = document.getElementById("setup-container");
  const setupInfoElement = document.getElementById("setup-info") as HTMLTextAreaElement | null;

  // セットアップ画面に戻ったら、次のタスク選択を許可する
  isTaskLaunchInProgress = false;
  initAiModelSelect();

  if (chatContainer) chatContainer.style.display = "none";
  if (setupContainer) setupContainer.style.display = "block";
  if (setupInfoElement) setupInfoElement.value = "";
  window.closeChatShareModal?.();

  // サイドバーの状態をクリーンアップ
  const sidebar = document.querySelector(".sidebar");
  if (sidebar) {
    sidebar.classList.remove("open");
  }
  document.body.classList.remove("sidebar-visible");

  loadTaskCards();
  scheduleSetupViewportFit();
}

// ▼ 3. タスクカード選択処理 --------------------------------------------------------
function initSetupTaskCards() {
  const container = document.getElementById("task-selection");
  if (!container) return;
  container.removeEventListener("click", handleTaskCardClick);
  container.addEventListener("click", handleTaskCardClick);
}

function handleTaskCardClick(e: Event) {
  if (window.isEditingOrder) return; // 並び替え中は無視
  if (isTaskLaunchInProgress) return; // 多重送信防止

  const target = e.target as Element | null;
  // 詳細ボタン（▼）経由のクリックではチャット送信しない
  if (target?.closest(".task-detail-toggle")) return;

  const card = target?.closest(".prompt-card") as HTMLElement | null;
  if (!card) return;

  isTaskLaunchInProgress = true;

  const setupInfoElement = document.getElementById("setup-info") as HTMLTextAreaElement | null;
  const aiModelSelect = document.getElementById("ai-model") as HTMLSelectElement | null;
  const chatMessages = document.getElementById("chat-messages");

  // 入力フォームの値（空欄可）
  const setupInfo = setupInfoElement ? setupInfoElement.value.trim() : "";
  const aiModel = aiModelSelect ? aiModelSelect.value : "openai/gpt-oss-20b";

  const taskName = card.dataset.task || "";

  // 新チャットルーム ID とタイトル
  const newRoomId = Date.now().toString();
  const roomTitle = setupInfo || "新規チャット";

  // currentChatRoomId はグローバルまたは他で定義されている前提
  window.currentChatRoomId = newRoomId;
  localStorage.setItem("currentChatRoomId", newRoomId);

  // ① ルームをサーバーに作成
  if (typeof window.createNewChatRoom === "function") {
    window.createNewChatRoom(newRoomId, roomTitle)
      .then(() => {
        if (typeof window.showChatInterface === "function") window.showChatInterface();
        // 新しいチャットではメッセージ表示をリセット
        if (chatMessages) chatMessages.innerHTML = "";
        if (typeof window.loadChatRooms === "function") window.loadChatRooms();
        localStorage.removeItem(`chatHistory_${newRoomId}`);

        // ② 最初のメッセージ
        const firstMsg = setupInfo
          ? `【タスク】${taskName}\n【状況・作業環境】${setupInfo}`
          : `【タスク】${taskName}`;

        // ③ Bot 応答生成
        if (typeof window.generateResponse === "function") window.generateResponse(firstMsg, aiModel);
      })
      .catch((err) => {
        isTaskLaunchInProgress = false;
        alert("チャットルーム作成に失敗: " + err);
      });
  } else {
    isTaskLaunchInProgress = false;
    console.error("createNewChatRoom is not defined");
  }
}

// ▼ 4. 「もっと見る」ボタン生成 ----------------------------------------------------
function initToggleTasks() {
  const container = document.querySelector<HTMLElement>(".task-selection");
  if (!container) return;
  const oldBtn = document.getElementById("toggle-tasks-btn");
  if (oldBtn) oldBtn.remove();

  const cards = [...container.querySelectorAll<HTMLElement>(".prompt-card")];

  // 以前の inline 指定が残っていても CSS クラス制御を優先する
  cards.forEach((card) => {
    if (card.style.display) card.style.removeProperty("display");
  });

  container.classList.remove("tasks-expanded");

  if (cards.length <= 6) {
    container.classList.remove("tasks-collapsed");
    scheduleSetupViewportFit();
    return;
  }

  container.classList.add("tasks-collapsed");

  // ボタン生成
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "toggle-tasks-btn";
  btn.className = "primary-button";
  btn.style.width = "100%";
  btn.style.marginTop = "0.1rem";

  let expanded = false;
  const applyExpandedState = () => {
    container.classList.toggle("tasks-expanded", expanded);
    btn.innerHTML = expanded ? '<i class="bi bi-chevron-up"></i> 閉じる' : '<i class="bi bi-chevron-down"></i> もっと見る';
  };

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    expanded = !expanded;
    applyExpandedState();
  });
  applyExpandedState();

  // ボタンをリストの末尾に追加
  const selectionContainer = window.taskSelection || container;
  selectionContainer.appendChild(btn);
  scheduleSetupViewportFit();
}

// ---- グローバル公開 -------------------------------------------------------------
window.showSetupForm = showSetupForm;
window.initToggleTasks = initToggleTasks;
window.initSetupTaskCards = initSetupTaskCards;
window.loadTaskCards = loadTaskCards;
window.invalidateTasksCache = invalidateTasksCache;

export {};
