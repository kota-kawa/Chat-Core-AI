import { browserSupportsPasskeys, PasskeyCancelledError, registerPasskey } from "../core/passkeys";

// settings.ts
// -----------------------------------------------
//  ユーザー設定フォーム (プロフィール取得／更新)
//  + サイドバーナビゲーション
//  + プロンプト管理機能
// -----------------------------------------------
const initSettingsPage = () => {
  const changeBtn = document.getElementById("changeAvatarBtn"); // 画像変更ボタン
  const fileInput = document.getElementById("avatarInput") as HTMLInputElement | null; // file 要素
  const previewImg = document.getElementById("avatarPreview") as HTMLImageElement | null; // プレビュー
  const togglePwd = document.getElementById("togglePasswordBtn"); // パスワード表示切替
  const cancelBtn = document.getElementById("cancelBtn"); // キャンセル
  const form = document.getElementById("userSettingsForm") as HTMLFormElement | null; // フォーム本体

  // ───────────────────────────
  // サイドバーナビゲーション
  // ───────────────────────────
  const navLinks = document.querySelectorAll<HTMLElement>(".nav-link");
  const sections = document.querySelectorAll<HTMLElement>(".settings-section");
  const promptListEntriesEl = document.getElementById("promptListEntries");
  const passkeySupportStatusEl = document.getElementById("passkeySupportStatus");
  const passkeyListEl = document.getElementById("passkeyList");
  const registerPasskeyBtn = document.getElementById("registerPasskeyBtn") as HTMLButtonElement | null;
  const refreshPasskeysBtn = document.getElementById("refreshPasskeysBtn") as HTMLButtonElement | null;

  navLinks.forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();

      // アクティブなリンクを更新
      navLinks.forEach((l) => l.classList.remove("active"));
      link.classList.add("active");

      // 対応するセクションを表示
      const targetSection = link.dataset.section;
      if (!targetSection) return;
      sections.forEach((section) => {
        if (section.id === `${targetSection}-section`) {
          section.classList.add("active");
        } else {
          section.classList.remove("active");
        }
      });

      // プロンプト管理セクションがアクティブになった時にプロンプトを読み込む
      if (targetSection === "prompts") {
        loadMyPrompts();
      } else if (targetSection === "prompt-list") {
        loadPromptList();
      } else if (targetSection === "security") {
        void loadPasskeys();
      }
    });
  });

  // ───────────────────────────
  // プロフィール設定機能
  // ───────────────────────────

  /* ───────── 画像選択 → プレビュー ───────── */
  changeBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement | null;
    const file = target?.files?.[0];
    if (file && file.type.startsWith("image/") && previewImg) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") previewImg.src = reader.result;
      };
      reader.readAsDataURL(file);
    }
  });

  /* ───────── パスワード表示／非表示 ───────── */
  togglePwd?.addEventListener("click", () => {
    const pwd = document.getElementById("password") as HTMLInputElement | null;
    if (!pwd) return;
    const isPwd = pwd.type === "password";
    pwd.type = isPwd ? "text" : "password";
    togglePwd.innerHTML = isPwd
      ? '<i class="bi bi-eye-slash"></i>'
      : '<i class="bi bi-eye"></i>';
  });

  /* ───────── キャンセル → フォームリセット ───────── */
  cancelBtn?.addEventListener("click", () => {
    form?.reset();
    if (previewImg) previewImg.src = "/static/user-icon.png"; // デフォルト画像
    if (togglePwd) togglePwd.innerHTML = '<i class="bi bi-eye"></i>'; // アイコン戻す
  });

  /* ───────── プロフィール取得 ───────── */
  async function loadProfile() {
    try {
      const res = await fetch("/api/user/profile", { credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "取得失敗");

      const usernameEl = document.getElementById("username") as HTMLInputElement | null;
      const emailEl = document.getElementById("email") as HTMLInputElement | null;
      const bioEl = document.getElementById("bio") as HTMLTextAreaElement | null;
      if (usernameEl) usernameEl.value = data.username ?? "";
      if (emailEl) emailEl.value = data.email ?? "";
      if (bioEl) bioEl.value = data.bio ?? "";
      if (data.avatar_url && previewImg) previewImg.src = data.avatar_url;
    } catch (err) {
      console.error("loadProfile:", (err as Error).message);
    }
  }

  /* ───────── プロフィール更新 ───────── */
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const usernameEl = document.getElementById("username") as HTMLInputElement | null;
    const emailEl = document.getElementById("email") as HTMLInputElement | null;
    const bioEl = document.getElementById("bio") as HTMLTextAreaElement | null;
    if (!usernameEl || !emailEl || !bioEl) {
      alert("フォーム要素が見つかりませんでした。");
      return;
    }

    const fd = new FormData();
    fd.append("username", usernameEl.value.trim());
    fd.append("email", emailEl.value.trim());
    fd.append("bio", bioEl.value.trim());
    if (fileInput?.files && fileInput.files.length > 0) fd.append("avatar", fileInput.files[0]);

    try {
      const res = await fetch("/api/user/profile", {
        method: "POST",
        body: fd,
        credentials: "same-origin"
      });
      const ctype = res.headers.get("Content-Type") || "";
      const body = ctype.includes("application/json")
        ? await res.json()
        : { error: await res.text() };

      if (!res.ok) throw new Error(body.error || "更新失敗");
      alert(body.message || "プロフィールを更新しました");
      if (body.avatar_url && previewImg) previewImg.src = body.avatar_url; // 新画像を即反映
    } catch (err) {
      alert("エラー: " + (err as Error).message);
    }
  });

  // ───────────────────────────
  // Passkey 管理
  // ───────────────────────────

  const formatDateTime = (value: unknown) => {
    if (typeof value !== "string" || !value) return "未使用";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "未使用" : date.toLocaleString();
  };

  const renderPasskeys = (passkeys: unknown[]) => {
    if (!passkeyListEl) return;

    if (passkeys.length === 0) {
      passkeyListEl.innerHTML = '<p class="passkey-empty">まだPasskeyは登録されていません。</p>';
      return;
    }

    passkeyListEl.innerHTML = passkeys
      .map((rawPasskey) => {
        const passkey = typeof rawPasskey === "object" && rawPasskey !== null
          ? (rawPasskey as Record<string, unknown>)
          : {};
        const id = Number(passkey.id);
        const label = typeof passkey.label === "string" && passkey.label.trim()
          ? passkey.label.trim()
          : "保存済みPasskey";
        const deviceType = typeof passkey.credential_device_type === "string"
          ? passkey.credential_device_type
          : "不明";
        const backedUp = passkey.credential_backed_up ? "あり" : "なし";

        return `
          <div class="passkey-item">
            <div>
              <strong>${escapeHtml(label)}</strong>
              <div class="passkey-meta">
                端末種別: ${escapeHtml(deviceType)}<br>
                バックアップ: ${escapeHtml(backedUp)}<br>
                作成日時: ${escapeHtml(formatDateTime(passkey.created_at))}<br>
                最終利用: ${escapeHtml(formatDateTime(passkey.last_used_at))}
              </div>
            </div>
            <button type="button" class="secondary-button delete-passkey-btn" data-passkey-id="${escapeHtml(id)}">
              削除
            </button>
          </div>
        `;
      })
      .join("");
  };

  async function loadPasskeys() {
    if (!passkeySupportStatusEl || !passkeyListEl) return;

    if (!browserSupportsPasskeys()) {
      passkeySupportStatusEl.textContent = "このブラウザではPasskeyを利用できません。";
      if (registerPasskeyBtn) registerPasskeyBtn.disabled = true;
      if (refreshPasskeysBtn) refreshPasskeysBtn.disabled = true;
      renderPasskeys([]);
      return;
    }

    passkeySupportStatusEl.textContent = "このブラウザはPasskeyに対応しています。";

    try {
      const response = await fetch("/api/passkeys", { credentials: "same-origin" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status === "fail") {
        throw new Error(typeof data.error === "string" ? data.error : "Passkey一覧の取得に失敗しました。");
      }
      renderPasskeys(Array.isArray(data.passkeys) ? data.passkeys : []);
    } catch (error) {
      renderPasskeys([]);
      alert((error as Error).message);
    }
  }

  // ───────────────────────────
  // プロンプト管理機能
  // ───────────────────────────

  // タイトル切り詰め関数
  function truncateTitle(title: string) {
    const chars = Array.from(title);
    return chars.length > 17 ? chars.slice(0, 17).join("") + "..." : title;
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

  type PromptRecord = {
    id?: string | number;
    title: string;
    content: string;
    category: string;
    inputExamples: string;
    outputExamples: string;
    createdAt?: string;
  };

  const asString = (value: unknown) => {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return String(value);
  };

  const asId = (value: unknown) => {
    if (typeof value === "string" || typeof value === "number") return value;
    return undefined;
  };

  const toPromptRecord = (raw: unknown): PromptRecord => {
    const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      id: asId(obj.id),
      title: asString(obj.title),
      content: asString(obj.content),
      category: asString(obj.category),
      inputExamples: asString(obj.input_examples),
      outputExamples: asString(obj.output_examples),
      createdAt: asString(obj.created_at) || undefined
    };
  };

  type PromptListEntry = {
    id?: string | number;
    title: string;
    content: string;
    category: string;
    inputExamples: string;
    outputExamples: string;
    createdAt?: string;
  };

  const toPromptListEntry = (raw: unknown): PromptListEntry => {
    const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return {
      id: asId(obj.id),
      title: asString(obj.title),
      content: asString(obj.content),
      category: asString(obj.category),
      inputExamples: asString(obj.input_examples),
      outputExamples: asString(obj.output_examples),
      createdAt: asString(obj.created_at) || undefined
    };
  };

  // プロンプト一覧読み込み
  function loadMyPrompts() {
    fetch("/prompt_manage/api/my_prompts")
      .then((response) => response.json())
      .then((data) => {
        const promptList = document.getElementById("promptList");
        if (!promptList) return;
        promptList.innerHTML = "";
        const prompts = Array.isArray(data.prompts) ? data.prompts : [];
        if (prompts.length > 0) {
          prompts.forEach((rawPrompt: unknown) => {
            const prompt = toPromptRecord(rawPrompt);
            const card = document.createElement("div");
            card.classList.add("prompt-card");
            const safeTitle = escapeHtml(truncateTitle(prompt.title));
            const safeContent = escapeHtml(prompt.content);
            const safeCategory = escapeHtml(prompt.category);
            const safeCreatedAt = escapeHtml(prompt.createdAt ? new Date(prompt.createdAt).toLocaleString() : "");
            const safeInputExamples = escapeHtml(prompt.inputExamples || "");
            const safeOutputExamples = escapeHtml(prompt.outputExamples || "");
            const safePromptId = escapeHtml(prompt.id ?? "");

            card.innerHTML = `
              <h3>${safeTitle}</h3>
              <p>${safeContent}</p>
              <div class="meta">
                <span>カテゴリ: ${safeCategory}</span><br>
                <span>投稿日: ${safeCreatedAt}</span>
              </div>
              <!-- 隠し要素として入力例と出力例を保持 -->
              <p class="d-none input-examples">${safeInputExamples}</p>
              <p class="d-none output-examples">${safeOutputExamples}</p>
              <div class="btn-group">
                <button class="btn btn-sm btn-warning edit-btn" data-id="${safePromptId}">
                  <i class="bi bi-pencil"></i> 編集
                </button>
                <button class="btn btn-sm btn-danger delete-btn" data-id="${safePromptId}">
                  <i class="bi bi-trash"></i> 削除
                </button>
              </div>
            `;
            promptList.appendChild(card);
          });
          attachEventHandlers();
        } else {
          promptList.innerHTML = "<p>プロンプトが存在しません。</p>";
        }
      })
      .catch((err) => {
        console.error("プロンプト取得エラー:", err);
        const promptList = document.getElementById("promptList");
        if (promptList) {
          promptList.innerHTML = "<p>プロンプトの読み込み中にエラーが発生しました。</p>";
        }
      });
  }

  function attachPromptListHandlers() {
    if (!promptListEntriesEl) return;

    promptListEntriesEl.querySelectorAll<HTMLButtonElement>(".remove-prompt-list-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const entryId = this.dataset.id;
        if (!entryId) return;
        if (!confirm("プロンプトリストから削除しますか？")) return;

        fetch(`/prompt_manage/api/prompt_list/${entryId}`, {
          method: "DELETE",
          credentials: "same-origin"
        })
          .then((response) => response.json())
          .then((result) => {
            if (result.error) {
              alert("削除エラー: " + result.error);
            } else {
              alert(result.message || "プロンプトを削除しました。");
              loadPromptList();
            }
          })
          .catch((err) => {
            console.error("プロンプトリストの削除中にエラーが発生しました:", err);
            alert("プロンプトリストの削除中にエラーが発生しました。");
          });
      });
    });
  }

  function loadPromptList() {
    if (!promptListEntriesEl) return;

    promptListEntriesEl.innerHTML = "<p>読み込み中...</p>";

    fetch("/prompt_manage/api/prompt_list", {
      credentials: "same-origin"
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || "プロンプトリストの取得に失敗しました。");
        }
        return data;
      })
      .then((data) => {
        if (!data.prompts || data.prompts.length === 0) {
          promptListEntriesEl.innerHTML = "<p>プロンプトリストは存在しません。</p>";
          return;
        }

        promptListEntriesEl.innerHTML = "";
        const entries = Array.isArray(data.prompts) ? data.prompts : [];
        entries.forEach((rawEntry: unknown) => {
          const entry = toPromptListEntry(rawEntry);
          const card = document.createElement("div");
          card.classList.add("prompt-card");

          const createdAt = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "";
          const safeTitle = escapeHtml(truncateTitle(entry.title));
          const safeContent = escapeHtml(entry.content);
          const safeCategory = escapeHtml(entry.category);
          const safeInputExamples = escapeHtml(entry.inputExamples);
          const safeOutputExamples = escapeHtml(entry.outputExamples);
          const safeCreatedAt = escapeHtml(createdAt);
          const safeEntryId = escapeHtml(entry.id ?? "");
          const safeCategoryBlock = entry.category
            ? `<div class="meta"><strong>カテゴリ:</strong> ${safeCategory}</div>`
            : "";
          const safeInputBlock = entry.inputExamples
            ? `<div class="meta"><strong>入力例:</strong> ${safeInputExamples}</div>`
            : "";
          const safeOutputBlock = entry.outputExamples
            ? `<div class="meta"><strong>出力例:</strong> ${safeOutputExamples}</div>`
            : "";

          card.innerHTML = `
            <h3>${safeTitle}</h3>
            <p>${safeContent}</p>
            ${safeCategoryBlock}
            ${safeInputBlock}
            ${safeOutputBlock}
            <div class="meta">
              <span>保存日: ${safeCreatedAt}</span>
            </div>
            <div class="btn-group">
              <button class="btn btn-sm btn-danger remove-prompt-list-btn" data-id="${safeEntryId}">
                <i class="bi bi-trash"></i> 削除
              </button>
            </div>
          `;

          promptListEntriesEl.appendChild(card);
        });

        attachPromptListHandlers();
      })
      .catch((err) => {
        console.error("プロンプトリスト取得エラー:", err);
        const message = err instanceof Error ? err.message : String(err);
        promptListEntriesEl.innerHTML = `<p>${escapeHtml(message)}</p>`;
      });
  }

  // 編集・削除ボタンのイベントハンドラー追加
  function attachEventHandlers() {
    // 編集ボタン
    document.querySelectorAll<HTMLButtonElement>(".edit-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const promptId = this.dataset.id;
        const card = this.closest(".prompt-card");
        if (!card || !promptId) return;

        // カードから情報を取得
        const title = card.querySelector("h3")?.textContent || "";
        const content = card.querySelector("p")?.textContent || "";
        const metaSpans = card.querySelectorAll(".meta span");
        const category = metaSpans[0]?.textContent?.replace("カテゴリ: ", "") || "";
        const inputExamples = card.querySelector(".input-examples")?.textContent || "";
        const outputExamples = card.querySelector(".output-examples")?.textContent || "";

        // モーダルフォームに値をセット
        const editPromptId = document.getElementById("editPromptId") as HTMLInputElement | null;
        const editTitle = document.getElementById("editTitle") as HTMLInputElement | null;
        const editCategory = document.getElementById("editCategory") as HTMLInputElement | null;
        const editContent = document.getElementById("editContent") as HTMLTextAreaElement | null;
        const editInputExamples = document.getElementById("editInputExamples") as HTMLTextAreaElement | null;
        const editOutputExamples = document.getElementById("editOutputExamples") as HTMLTextAreaElement | null;
        if (!editPromptId || !editTitle || !editCategory || !editContent || !editInputExamples || !editOutputExamples) {
          alert("編集フォームが見つかりませんでした。");
          return;
        }
        editPromptId.value = promptId;
        editTitle.value = title;
        editCategory.value = category;
        editContent.value = content;
        editInputExamples.value = inputExamples;
        editOutputExamples.value = outputExamples;

        // モーダルを表示
        const editModalEl = document.getElementById("editModal");
        if (editModalEl) {
          const editModal = new bootstrap.Modal(editModalEl);
          editModal.show();
        }
      });
    });

    // 削除ボタン
    document.querySelectorAll<HTMLButtonElement>(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const promptId = this.dataset.id;
        if (!promptId) return;
        if (confirm("このプロンプトを削除しますか？")) {
          fetch(`/prompt_manage/api/prompts/${promptId}`, {
            method: "DELETE"
          })
            .then((response) => response.json())
            .then((result) => {
              if (result.error) {
                alert("削除エラー: " + result.error);
              } else {
                alert(result.message);
                loadMyPrompts(); // 一覧を再読み込み
              }
            })
            .catch((err) => {
              console.error("削除中のエラー:", err);
              alert("プロンプトの削除中にエラーが発生しました。");
            });
        }
      });
    });
  }

  // 編集フォームの送信処理
  const editForm = document.getElementById("editForm") as HTMLFormElement | null;
  editForm?.addEventListener("submit", function (e) {
    e.preventDefault();
    const promptId = (document.getElementById("editPromptId") as HTMLInputElement | null)?.value;
    const title = (document.getElementById("editTitle") as HTMLInputElement | null)?.value;
    const category = (document.getElementById("editCategory") as HTMLInputElement | null)?.value;
    const content = (document.getElementById("editContent") as HTMLTextAreaElement | null)?.value;
    const inputExamples = (document.getElementById("editInputExamples") as HTMLTextAreaElement | null)?.value;
    const outputExamples = (document.getElementById("editOutputExamples") as HTMLTextAreaElement | null)?.value;
    if (!promptId || !title || !category || !content || inputExamples === undefined || outputExamples === undefined) {
      alert("編集フォームの値が不足しています。");
      return;
    }

    fetch(`/prompt_manage/api/prompts/${promptId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title,
        category,
        content,
        input_examples: inputExamples,
        output_examples: outputExamples
      })
    })
      .then((response) => response.json())
      .then((result) => {
        if (result.error) {
          alert("更新エラー: " + result.error);
        } else {
          alert(result.message);
          // モーダルを閉じて一覧を再読み込み
          const editModalEl = document.getElementById("editModal");
          const modal = bootstrap.Modal.getInstance(editModalEl);
          modal?.hide();
          loadMyPrompts();
        }
      })
      .catch((err) => {
        console.error("更新中のエラー:", err);
        alert("プロンプトの更新中にエラーが発生しました。");
      });
  });

  registerPasskeyBtn?.addEventListener("click", async () => {
    registerPasskeyBtn.disabled = true;
    try {
      await registerPasskey();
      alert("Passkeyを追加しました。");
      await loadPasskeys();
    } catch (error) {
      if (error instanceof PasskeyCancelledError) {
        return;
      }
      alert((error as Error).message);
    } finally {
      registerPasskeyBtn.disabled = false;
    }
  });

  refreshPasskeysBtn?.addEventListener("click", () => {
    void loadPasskeys();
  });

  passkeyListEl?.addEventListener("click", async (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest(".delete-passkey-btn") : null;
    if (!(target instanceof HTMLButtonElement)) return;

    const rawPasskeyId = target.dataset.passkeyId;
    if (!rawPasskeyId) return;
    if (!window.confirm("このPasskeyを削除しますか？")) return;

    target.disabled = true;
    try {
      const response = await fetch("/api/passkeys/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passkey_id: Number(rawPasskeyId) }),
        credentials: "same-origin"
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status === "fail") {
        throw new Error(typeof data.error === "string" ? data.error : "Passkeyの削除に失敗しました。");
      }
      await loadPasskeys();
    } catch (error) {
      alert((error as Error).message);
      target.disabled = false;
    }
  });

  // 初期表示時に現在のプロフィールを読み込む
  loadProfile();
  void loadPasskeys();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSettingsPage);
} else {
  initSettingsPage();
}

export {};
