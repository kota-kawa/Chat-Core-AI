type PromptData = {
  id?: string | number;
  title: string;
  content: string;
  category?: string;
  author?: string;
  input_examples?: string;
  output_examples?: string;
  bookmarked?: boolean;
  saved_to_list?: boolean;
  created_at?: string;
};

const AUTH_STATE_CACHE_KEY = "chatcore.auth.loggedIn";
const PROMPTS_CACHE_KEY = "prompt_share.prompts.v1";

function readCachedAuthState() {
  try {
    const cached = localStorage.getItem(AUTH_STATE_CACHE_KEY);
    if (cached === "1") return true;
    if (cached === "0") return false;
  } catch {
    // localStorage が使えない環境ではキャッシュを無視
  }
  return null;
}

function writeCachedAuthState(loggedIn: boolean) {
  try {
    localStorage.setItem(AUTH_STATE_CACHE_KEY, loggedIn ? "1" : "0");
  } catch {
    // localStorage が使えない環境では保存をスキップ
  }
}

function readPromptCache() {
  try {
    const raw = sessionStorage.getItem(PROMPTS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed as PromptData[];
  } catch {
    return null;
  }
}

function writePromptCache(prompts: PromptData[]) {
  try {
    sessionStorage.setItem(PROMPTS_CACHE_KEY, JSON.stringify(prompts));
  } catch {
    // sessionStorage が使えない環境では保存をスキップ
  }
}

function initPromptSharePage(attempt = 0) {
  const promptContainer = document.querySelector(".prompt-cards") as HTMLElement | null;
  if (!promptContainer) {
    if (attempt < 10) {
      requestAnimationFrame(() => initPromptSharePage(attempt + 1));
    }
    return;
  }
  if (promptContainer.dataset.psInitialized === "true") {
    return;
  }
  promptContainer.dataset.psInitialized = "true";
  const promptCountMeta = document.getElementById("promptCountMeta") as HTMLElement | null;

  function setPromptCountMeta(text: string) {
    if (!promptCountMeta) return;
    promptCountMeta.textContent = text;
  }

  // ログイン状態の確認とUI切り替え
  const userIcon = document.getElementById("userIcon");
  const authButtons = document.getElementById("auth-buttons");
  let isLoggedIn = false; // ログイン状態を保持

  const applyAuthUI = (loggedIn: boolean) => {
    if (loggedIn) {
      if (authButtons) authButtons.style.display = "none";
      if (userIcon) userIcon.style.display = "";
      return;
    }

    if (authButtons) authButtons.style.display = "";
    if (userIcon) userIcon.style.display = "none";
    const loginBtn = document.getElementById("login-btn");
    if (loginBtn) loginBtn.onclick = () => (window.location.href = "/login");
  };

  // 前回状態を先に反映してポップインを抑える
  const cachedAuthState = readCachedAuthState();
  if (cachedAuthState !== null) {
    isLoggedIn = cachedAuthState;
    applyAuthUI(cachedAuthState);
  }

  window.setTimeout(() => {
    fetch("/api/current_user")
      .then((res) => (res.ok ? res.json() : { logged_in: false }))
      .then((data) => {
        isLoggedIn = Boolean(data.logged_in);
        writeCachedAuthState(isLoggedIn);
        applyAuthUI(isLoggedIn);
      })
      .catch((err) => {
        console.error("Error checking login status:", err);
        applyAuthUI(false);
      });
  }, 0);

  function closeAllDropdowns(exceptCard?: HTMLElement | null) {
    const openMenus = document.querySelectorAll<HTMLElement>(".prompt-actions-dropdown.is-open");
    openMenus.forEach((menu) => {
      if (exceptCard && exceptCard.contains(menu)) {
        return;
      }
      menu.classList.remove("is-open");
      const trigger = menu.parentElement?.querySelector(".meatball-menu") as HTMLElement | null;
      if (trigger) {
        trigger.setAttribute("aria-expanded", "false");
      }
      const parentCard = menu.closest(".prompt-card");
      if (parentCard) {
        parentCard.classList.remove("menu-open");
      }
    });
  }

  if (document.body && document.body.dataset.psDropdownListener !== "true") {
    document.body.dataset.psDropdownListener = "true";
    document.addEventListener("click", () => closeAllDropdowns());
  }

  const TITLE_CHAR_LIMIT = 17;
  const CONTENT_CHAR_LIMIT = 160;

  function truncateText(text: string, limit: number) {
    const safeText = text || "";
    const chars = Array.from(safeText);
    return chars.length > limit ? chars.slice(0, limit).join("") + "..." : safeText;
  }

  function truncateTitle(title: string) {
    return truncateText(title, TITLE_CHAR_LIMIT);
  }

  function truncateContent(content: string) {
    return truncateText(content, CONTENT_CHAR_LIMIT);
  }

  function formatPromptDate(createdAt?: string) {
    if (!createdAt) return "";
    const parsedDate = new Date(createdAt);
    if (Number.isNaN(parsedDate.getTime())) return "";
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(parsedDate);
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

  function getBookmarkButtonMarkup(isBookmarked: boolean) {
    const iconClass = isBookmarked ? "bi-bookmark-check-fill" : "bi-bookmark";
    const label = isBookmarked ? "保存済み" : "保存";
    return `<i class="bi ${iconClass}"></i><span>${label}</span>`;
  }

  function renderPromptStatusMessage(message: string, variant: "empty" | "error" = "empty") {
    if (!promptContainer) return;
    promptContainer.innerHTML = `<p class="prompt-feedback prompt-feedback--${variant}">${escapeHtml(message)}</p>`;
  }

  function updateBookmarkButtonState(button: HTMLButtonElement | null, isBookmarked: boolean) {
    if (!button) return;
    button.classList.toggle("bookmarked", isBookmarked);
    button.setAttribute("aria-pressed", isBookmarked ? "true" : "false");
    button.innerHTML = getBookmarkButtonMarkup(isBookmarked);
  }

  function sendBookmarkRequest(method: "POST" | "DELETE", payload: Record<string, unknown>) {
    return fetch("/prompt_share/api/bookmark", {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        throw new Error(data.error || "操作に失敗しました。");
      }
      return data;
    });
  }

  function savePromptBookmark(prompt: PromptData) {
    return sendBookmarkRequest("POST", {
      title: prompt.title,
      content: prompt.content,
      input_examples: prompt.input_examples || "",
      output_examples: prompt.output_examples || ""
    });
  }

  function removePromptBookmark(prompt: PromptData) {
    return sendBookmarkRequest("DELETE", {
      title: prompt.title
    });
  }

  function savePromptToList(prompt: PromptData) {
    return fetch("/prompt_share/api/prompt_list", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt_id: prompt.id ?? null,
        title: prompt.title,
        category: prompt.category || "",
        content: prompt.content,
        input_examples: prompt.input_examples || "",
        output_examples: prompt.output_examples || ""
      })
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.error) {
        throw new Error(data.error || "操作に失敗しました。");
      }
      return data;
    });
  }

  function createPromptCardElement(prompt: PromptData) {
    const card = document.createElement("div");
    card.classList.add("prompt-card");
    if (prompt.category) {
      card.setAttribute("data-category", prompt.category);
    }

    const isBookmarked = Boolean(prompt.bookmarked);
    const isSavedToList = Boolean(prompt.saved_to_list);
    const truncatedContent = truncateContent(prompt.content);
    const safeTitle = escapeHtml(truncateTitle(prompt.title));
    const safeContent = escapeHtml(truncatedContent);
    const safeCategory = escapeHtml(prompt.category || "未分類");
    const safeAuthor = escapeHtml(prompt.author || "匿名ユーザー");
    const safeCreatedAt = escapeHtml(formatPromptDate(prompt.created_at) || "日付未設定");
    const bookmarkIcon = getBookmarkButtonMarkup(isBookmarked);

    card.innerHTML = `
      <div class="prompt-card__header">
        <span class="prompt-card__category-pill">
          <i class="bi bi-hash"></i>
          <span>${safeCategory}</span>
        </span>
        <button class="meatball-menu" type="button" aria-label="その他の操作" aria-haspopup="true" aria-expanded="false">
          <i class="bi bi-three-dots"></i>
        </button>
      </div>

      <div class="prompt-actions-dropdown" role="menu">
        <button class="dropdown-item" type="button" role="menuitem" data-action="save-to-list" ${isSavedToList ? "disabled" : ""}>
          ${isSavedToList ? "プロンプトリストに保存済み" : "プロンプトリストに保存"}
        </button>
        <button class="dropdown-item" type="button" role="menuitem">ミュート</button>
        <button class="dropdown-item" type="button" role="menuitem">報告する</button>
      </div>

      <h3>${safeTitle}</h3>
      <p class="prompt-card__content">${safeContent}</p>

      <div class="prompt-meta">
        <div class="prompt-meta-info">
          <span class="prompt-meta-pill">
            <i class="bi bi-person"></i>
            ${safeAuthor}
          </span>
          <span class="prompt-meta-pill">
            <i class="bi bi-calendar3"></i>
            ${safeCreatedAt}
          </span>
        </div>
        <div class="prompt-actions">
          <button class="prompt-action-btn comment-btn" type="button" aria-label="コメント">
            <i class="bi bi-chat-dots"></i>
            <span>コメント</span>
          </button>
          <button class="prompt-action-btn like-btn" type="button" aria-label="いいね" aria-pressed="false">
            <i class="bi bi-heart"></i>
            <span>いいね</span>
          </button>
          <button class="prompt-action-btn bookmark-btn ${isBookmarked ? "bookmarked" : ""}" type="button" aria-label="保存" aria-pressed="${isBookmarked ? "true" : "false"}">
            ${bookmarkIcon}
          </button>
        </div>
      </div>
    `;

    card.dataset.fullTitle = prompt.title || "";
    card.dataset.fullContent = prompt.content || "";
    card.dataset.savedToList = isSavedToList ? "true" : "false";
    card.dataset.psBound = "true";

    const bookmarkBtn = card.querySelector(".bookmark-btn") as HTMLButtonElement | null;
    if (bookmarkBtn) {
      bookmarkBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!isLoggedIn) {
          alert("ブックマークするにはログインが必要です。");
          return;
        }

        const shouldBookmark = !bookmarkBtn.classList.contains("bookmarked");
        bookmarkBtn.disabled = true;

        const request = shouldBookmark ? savePromptBookmark(prompt) : removePromptBookmark(prompt);

        request
          .then((result) => {
            updateBookmarkButtonState(bookmarkBtn, shouldBookmark);
            prompt.bookmarked = shouldBookmark;
            if (result && result.message) {
              console.log(result.message);
            }
          })
          .catch((err) => {
            console.error("ブックマーク操作エラー:", err);
            alert("ブックマークの更新中にエラーが発生しました。");
          })
          .finally(() => {
            bookmarkBtn.disabled = false;
          });
      });
      bookmarkBtn.dataset.bound = "true";
    }

    const commentBtn = card.querySelector(".comment-btn") as HTMLButtonElement | null;
    if (commentBtn) {
      commentBtn.addEventListener("click", function (e) {
        e.stopPropagation();
      });
    }

    const likeBtn = card.querySelector(".like-btn") as HTMLButtonElement | null;
    if (likeBtn) {
      likeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        const liked = likeBtn.classList.toggle("liked");
        likeBtn.setAttribute("aria-pressed", liked ? "true" : "false");
        const icon = likeBtn.querySelector("i");
        if (icon) {
          icon.classList.toggle("bi-heart");
          icon.classList.toggle("bi-heart-fill");
        }
        const label = likeBtn.querySelector("span");
        if (label) {
          label.textContent = liked ? "いいね済み" : "いいね";
        }
      });
    }

    const meatballBtn = card.querySelector(".meatball-menu") as HTMLButtonElement | null;
    const dropdownMenu = card.querySelector(".prompt-actions-dropdown") as HTMLElement | null;
    if (meatballBtn && dropdownMenu) {
      meatballBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        const willOpen = !dropdownMenu.classList.contains("is-open");
        closeAllDropdowns(card);
        dropdownMenu.classList.toggle("is-open", willOpen);
        meatballBtn.setAttribute("aria-expanded", willOpen ? "true" : "false");
        card.classList.toggle("menu-open", willOpen);
      });

      dropdownMenu.addEventListener("click", (event) => {
        event.stopPropagation();
      });

      dropdownMenu.querySelectorAll<HTMLButtonElement>(".dropdown-item").forEach((item) => {
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          dropdownMenu.classList.remove("is-open");
          meatballBtn.setAttribute("aria-expanded", "false");
          card.classList.remove("menu-open");
        });
      });

      const saveMenuItem = dropdownMenu.querySelector<HTMLButtonElement>('[data-action="save-to-list"]');
      if (saveMenuItem) {
        saveMenuItem.addEventListener("click", () => {
          if (!isLoggedIn) {
            alert("プロンプトを保存するにはログインが必要です。");
            return;
          }

          if (prompt.saved_to_list) {
            alert("このプロンプトはすでにプロンプトリストに保存されています。");
            return;
          }

          saveMenuItem.disabled = true;
          savePromptToList(prompt)
            .then((result) => {
              prompt.saved_to_list = true;
              card.dataset.savedToList = "true";
              saveMenuItem.textContent = "プロンプトリストに保存済み";
              saveMenuItem.disabled = true;
              if (result && result.message) {
                console.log(result.message);
              }
            })
            .catch((err) => {
              console.error("プロンプト保存中にエラーが発生しました:", err);
              alert("プロンプトリストへの保存中にエラーが発生しました。");
            })
            .finally(() => {
              if (!prompt.saved_to_list) {
                saveMenuItem.disabled = false;
              }
            });
        });
      }
    }

    card.addEventListener("click", function (e) {
      const target = e.target as Element | null;
      if (target?.closest(".prompt-action-btn") || target?.closest(".meatball-menu")) {
        return;
      }
      closeAllDropdowns();
      showPromptDetailModal(prompt);
    });

    return card;
  }

  // ------------------------------
  // サーバーからプロンプト一覧を取得して表示する関数（Promise を返す）
  // ------------------------------
  function normalizePromptData(prompt: PromptData): PromptData {
    return {
      ...prompt,
      bookmarked: Boolean(prompt.bookmarked),
      saved_to_list: Boolean(prompt.saved_to_list)
    };
  }

  function renderPromptCards(
    prompts: PromptData[],
    options?: { emptyMessage?: string; countLabel?: string }
  ) {
    if (!promptContainer) return;

    const countLabel = options?.countLabel || "公開プロンプト";
    setPromptCountMeta(`${countLabel}: ${prompts.length}件`);
    promptContainer.innerHTML = "";
    if (!prompts.length) {
      renderPromptStatusMessage(options?.emptyMessage || "プロンプトが見つかりませんでした。");
      return;
    }

    const fragment = document.createDocumentFragment();
    prompts.forEach((prompt) => {
      fragment.appendChild(createPromptCardElement(normalizePromptData(prompt)));
    });
    promptContainer.appendChild(fragment);
  }

  function loadPrompts() {
    return fetch("/prompt_share/api/prompts")
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        const prompts = Array.isArray(data.prompts) ? data.prompts.map(normalizePromptData) : [];
        writePromptCache(prompts);
        renderPromptCards(prompts, { countLabel: "公開プロンプト" });
        const activeCategoryCard = document.querySelector<HTMLElement>(".category-card.active");
        if (activeCategoryCard) {
          applyCategoryFilter(activeCategoryCard);
        }
      })
      .catch((err) => {
        console.error("プロンプト取得エラー:", err);
        const message = err instanceof Error ? err.message : String(err);
        setPromptCountMeta("読み込みに失敗しました");
        renderPromptStatusMessage(`エラーが発生しました: ${message}`, "error");
      });
  }

  // キャッシュがあれば先に描画してから、サーバーの最新データで更新する
  const cachedPrompts = readPromptCache();
  if (cachedPrompts && cachedPrompts.length > 0) {
    renderPromptCards(cachedPrompts, { countLabel: "公開プロンプト" });
  }
  void loadPrompts();

  // ------------------------------
  // 検索機能（サーバー側検索）
  // ------------------------------
  const searchInput = document.getElementById("searchInput") as HTMLInputElement | null;
  const searchButton = document.getElementById("searchButton");
  const promptCardsSection = promptContainer;
  const selectedCategoryTitle = document.getElementById("selected-category-title");

  function searchPromptsServer() {
    if (!searchInput || !promptCardsSection || !selectedCategoryTitle) {
      return;
    }
    const query = searchInput.value.trim();

    // クエリが空の場合は、全プロンプトを再表示
    if (!query) {
      loadPrompts();
      selectedCategoryTitle.textContent = "全てのプロンプト";
      return;
    }

    // ヘッダーを検索結果用に更新
    selectedCategoryTitle.textContent = `検索結果: 「${query}」`;

    fetch(`/search/prompts?q=${encodeURIComponent(query)}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        const searchResults = Array.isArray(data.prompts)
          ? data.prompts.map(normalizePromptData)
          : [];
        renderPromptCards(searchResults, {
          countLabel: "検索結果",
          emptyMessage: "該当するプロンプトが見つかりませんでした。"
        });
      })
      .catch((err) => {
        console.error("検索エラー:", err);
        const message = err instanceof Error ? err.message : String(err);
        setPromptCountMeta("検索に失敗しました");
        renderPromptStatusMessage(`エラーが発生しました: ${message}`, "error");
      });
  }

  if (searchButton && searchInput) {
    searchButton.addEventListener("click", searchPromptsServer);
    searchInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        searchPromptsServer();
      }
    });
  }

  // ------------------------------
  // カテゴリ選択と表示
  // ------------------------------
  const categoryCards = document.querySelectorAll<HTMLElement>(".category-card");
  if (categoryCards.length > 0 && selectedCategoryTitle) {
    categoryCards.forEach((card) => {
      card.addEventListener("click", () => {
        // 検索結果状態の場合は、検索入力をクリアし最新の全プロンプトを再取得
        if (searchInput && searchInput.value.trim() !== "") {
          searchInput.value = "";
          loadPrompts().then(() => {
            applyCategoryFilter(card);
          });
        } else {
          applyCategoryFilter(card);
        }
      });
    });
  }

  // カテゴリフィルタを適用する関数
  function applyCategoryFilter(card: HTMLElement) {
    // 全カテゴリボタンの active クラスをリセット
    categoryCards.forEach((c) => c.classList.remove("active"));
    card.classList.add("active");

    const selectedCategory = card.getAttribute("data-category") || "all";
    selectedCategoryTitle!.textContent =
      selectedCategory === "all" ? "全てのプロンプト" : `${selectedCategory} のプロンプト`;

    // 表示中のプロンプトカードにフィルタを適用
    const promptCards = document.querySelectorAll<HTMLElement>(".prompt-card");
    promptCards.forEach((prompt) => {
      const promptCategory = prompt.getAttribute("data-category");
      prompt.style.display =
        selectedCategory === "all" || promptCategory === selectedCategory ? "" : "none";
    });

    const visibleCount = Array.from(promptCards).filter(
      (prompt) => prompt.style.display !== "none"
    ).length;
    const countLabel = selectedCategory === "all" ? "公開プロンプト" : `${selectedCategory}`;
    setPromptCountMeta(`${countLabel}: ${visibleCount}件`);
  }

  // ------------------------------
  // 投稿フォームの送信処理
  // ------------------------------
  const postForm = document.getElementById("postForm") as HTMLFormElement | null;
  if (postForm) {
    postForm.addEventListener("submit", function (e) {
      e.preventDefault();

      const titleInput = document.getElementById("prompt-title") as HTMLInputElement | null;
      const categoryInput = document.getElementById("prompt-category") as HTMLInputElement | null;
      const contentInput = document.getElementById("prompt-content") as HTMLTextAreaElement | null;
      const authorInput = document.getElementById("prompt-author") as HTMLInputElement | null;
      if (!titleInput || !categoryInput || !contentInput || !authorInput) {
        alert("フォーム要素が見つかりませんでした。ページを再読み込みしてください。");
        return;
      }

      const title = titleInput.value;
      const category = categoryInput.value;
      const content = contentInput.value;
      const author = authorInput.value;

      // ガードレール使用のチェックと値取得
      const guardrailCheckbox = document.getElementById("guardrail-checkbox") as HTMLInputElement | null;
      const useGuardrail = guardrailCheckbox ? guardrailCheckbox.checked : false;
      let input_examples = "";
      let output_examples = "";
      if (useGuardrail) {
        const inputExample = document.getElementById("prompt-input-example") as HTMLTextAreaElement | null;
        const outputExample = document.getElementById("prompt-output-example") as HTMLTextAreaElement | null;
        input_examples = inputExample ? inputExample.value : "";
        output_examples = outputExample ? outputExample.value : "";
      }

      // すべての投稿を公開するため、常に true に設定
      const isPublic = true;

      const postData = {
        title: title,
        category: category,
        content: content,
        author: author,
        input_examples: input_examples,
        output_examples: output_examples,
        is_public: isPublic
      };

      fetch("/prompt_share/api/prompts", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(postData)
      })
        .then((response) => response.json())
        .then((result) => {
          if (result.error) {
            alert("エラー: " + result.error);
          } else {
            alert("プロンプトが投稿されました！");
            // フォームリセット＆モーダルを閉じる
            postForm.reset();
            const guardrailFields = document.getElementById("guardrail-fields");
            if (guardrailFields) {
              guardrailFields.style.display = "none";
            }
            const postModalElement = document.getElementById("postModal") as HTMLElement | null;
            if (postModalElement) {
              closeModal(postModalElement, { rotateTrigger: true });
            }
            // 最新のプロンプト一覧を再読み込み
            loadPrompts();
          }
        })
        .catch((err) => {
          console.error("投稿エラー:", err);
          alert("プロンプト投稿中にエラーが発生しました。");
        });
    });
  }

  // ------------------------------
  // 投稿モーダルの表示・非表示
  // ------------------------------
  const openModalBtn = document.getElementById("openPostModal");
  const heroOpenModalBtn = document.getElementById("heroOpenPostModal");
  const postModal = document.getElementById("postModal") as HTMLElement | null;
  const closeModalBtn = document.querySelector("#postModal .close-btn") as HTMLButtonElement | null;
  const promptDetailModal = document.getElementById("promptDetailModal") as HTMLElement | null;
  const closePromptDetailModalBtn = document.getElementById("closePromptDetailModal") as HTMLButtonElement | null;
  const postModalTitleInput = document.getElementById("prompt-title") as HTMLInputElement | null;
  const newPromptIcon = openModalBtn ? openModalBtn.querySelector("i") : null;
  let activeModal: HTMLElement | null = null;
  let previouslyFocusedElement: HTMLElement | null = null;
  let lockedScrollY = 0;

  function getModalFocusableElements(modal: HTMLElement) {
    const selector = [
      "a[href]",
      "area[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(", ");

    return Array.from(modal.querySelectorAll<HTMLElement>(selector)).filter((element) => {
      const style = window.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  function focusModal(modal: HTMLElement, preferredElement?: HTMLElement | null) {
    const fallbackTarget =
      modal.querySelector<HTMLElement>(".post-modal-content") || (modal as HTMLElement);
    const focusableElements = getModalFocusableElements(modal);
    const target =
      (preferredElement && getModalFocusableElements(modal).includes(preferredElement)
        ? preferredElement
        : null) ||
      focusableElements[0] ||
      fallbackTarget;

    window.requestAnimationFrame(() => {
      target.focus();
    });
  }

  function lockBackgroundInteraction() {
    if (document.body.classList.contains("ps-modal-open")) {
      return;
    }

    lockedScrollY = window.scrollY || window.pageYOffset || 0;
    document.documentElement.classList.add("ps-modal-open");
    document.body.classList.add("ps-modal-open");
    document.body.style.position = "fixed";
    document.body.style.top = `-${lockedScrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
  }

  function unlockBackgroundInteraction() {
    document.documentElement.classList.remove("ps-modal-open");
    document.body.classList.remove("ps-modal-open");
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.left = "";
    document.body.style.right = "";
    document.body.style.width = "";
    window.scrollTo(0, lockedScrollY);
  }

  function openModal(modal: HTMLElement, preferredElement?: HTMLElement | null) {
    previouslyFocusedElement = document.activeElement as HTMLElement | null;
    activeModal = modal;
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    lockBackgroundInteraction();
    focusModal(modal, preferredElement);
  }

  function closeModal(modal: HTMLElement, options?: { rotateTrigger?: boolean }) {
    if (!modal.classList.contains("show")) {
      return;
    }

    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
    if (options?.rotateTrigger) {
      triggerNewPromptIconRotation();
    }

    if (activeModal === modal) {
      activeModal = null;
    }

    const hasVisibleModal = Boolean(document.querySelector(".post-modal.show"));
    if (!hasVisibleModal) {
      unlockBackgroundInteraction();
      if (previouslyFocusedElement) {
        previouslyFocusedElement.focus();
      }
      previouslyFocusedElement = null;
    }
  }

  function handleModalKeydown(event: KeyboardEvent) {
    if (!activeModal || !activeModal.classList.contains("show")) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeModal(activeModal, { rotateTrigger: activeModal === postModal });
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusableElements = getModalFocusableElements(activeModal);
    if (focusableElements.length === 0) {
      event.preventDefault();
      const fallback = activeModal.querySelector<HTMLElement>(".post-modal-content");
      fallback?.focus();
      return;
    }

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];
    const currentElement = document.activeElement as HTMLElement | null;

    if (event.shiftKey) {
      if (!currentElement || currentElement === firstFocusable || !activeModal.contains(currentElement)) {
        event.preventDefault();
        lastFocusable.focus();
      }
      return;
    }

    if (!currentElement || currentElement === lastFocusable || !activeModal.contains(currentElement)) {
      event.preventDefault();
      firstFocusable.focus();
    }
  }

  const triggerNewPromptIconRotation = () => {
    if (!newPromptIcon) {
      return;
    }
    newPromptIcon.classList.remove("rotating");
    void (newPromptIcon as HTMLElement).offsetWidth;
    newPromptIcon.classList.add("rotating");
  };

  if (newPromptIcon) {
    newPromptIcon.addEventListener("animationend", () => {
      newPromptIcon.classList.remove("rotating");
    });
  }

  if (document.body && document.body.dataset.psModalKeydownListener !== "true") {
    document.body.dataset.psModalKeydownListener = "true";
    document.addEventListener("keydown", handleModalKeydown);
  }

  const openComposerModal = () => {
    if (!postModal) return;
    if (!isLoggedIn) {
      alert("プロンプトを投稿するにはログインが必要です。");
      return;
    }

    triggerNewPromptIconRotation();
    openModal(postModal, postModalTitleInput);
  };

  if (openModalBtn && postModal) {
    openModalBtn.addEventListener("click", openComposerModal);
  }

  if (heroOpenModalBtn && postModal) {
    heroOpenModalBtn.addEventListener("click", openComposerModal);
  }

  if (closeModalBtn && postModal) {
    closeModalBtn.addEventListener("click", function () {
      closeModal(postModal, { rotateTrigger: true });
    });
  }

  if (postModal && postModal.dataset.psBackdropListener !== "true") {
    postModal.dataset.psBackdropListener = "true";
    postModal.addEventListener("click", function (event) {
      if (event.target === postModal) {
        closeModal(postModal, { rotateTrigger: true });
      }
    });
  }

  // ------------------------------
  // ガードレールの表示切替処理
  // ------------------------------
  const guardrailCheckbox = document.getElementById("guardrail-checkbox") as HTMLInputElement | null;
  const guardrailFields = document.getElementById("guardrail-fields");

  if (guardrailCheckbox && guardrailFields) {
    guardrailCheckbox.addEventListener("change", function () {
      guardrailFields.style.display = guardrailCheckbox.checked ? "block" : "none";
    });
  }

  // ------------------------------
  // プロンプト詳細モーダル機能
  // ------------------------------
  function showPromptDetailModal(prompt: PromptData) {
    const modal = document.getElementById("promptDetailModal");
    const modalTitle = document.getElementById("modalPromptTitle");
    const modalCategory = document.getElementById("modalPromptCategory");
    const modalContent = document.getElementById("modalPromptContent");
    const modalAuthor = document.getElementById("modalPromptAuthor");
    const modalInputExamples = document.getElementById("modalInputExamples");
    const modalOutputExamples = document.getElementById("modalOutputExamples");
    const modalInputExamplesGroup = document.getElementById("modalInputExamplesGroup");
    const modalOutputExamplesGroup = document.getElementById("modalOutputExamplesGroup");

    if (!modal || !modalTitle || !modalCategory || !modalContent || !modalAuthor) return;

    // モーダルにデータを設定
    modalTitle.textContent = prompt.title;
    modalCategory.textContent = prompt.category || "";
    modalContent.textContent = prompt.content;
    modalAuthor.textContent = prompt.author || "";

    // 入力例・出力例がある場合のみ表示
    if (prompt.input_examples && modalInputExamples && modalInputExamplesGroup) {
      modalInputExamples.textContent = prompt.input_examples;
      modalInputExamplesGroup.style.display = "block";
    } else if (modalInputExamplesGroup) {
      modalInputExamplesGroup.style.display = "none";
    }

    if (prompt.output_examples && modalOutputExamples && modalOutputExamplesGroup) {
      modalOutputExamples.textContent = prompt.output_examples;
      modalOutputExamplesGroup.style.display = "block";
    } else if (modalOutputExamplesGroup) {
      modalOutputExamplesGroup.style.display = "none";
    }

    // モーダルを表示
    openModal(modal, closePromptDetailModalBtn);
  }

  // 閉じるボタンでモーダルを閉じる
  if (closePromptDetailModalBtn && promptDetailModal) {
    closePromptDetailModalBtn.addEventListener("click", function () {
      closeModal(promptDetailModal);
    });
  }

  // モーダル背景クリックで閉じる
  if (promptDetailModal) {
    promptDetailModal.addEventListener("click", function (e) {
      if (e.target === promptDetailModal) {
        closeModal(promptDetailModal);
      }
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initPromptSharePage());
} else {
  initPromptSharePage();
}

export {};
