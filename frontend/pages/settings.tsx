import Head from "next/head";
import Script from "next/script";
import { useEffect, useState } from "react";

const bodyMarkup = `
<div class="user-settings-layout">
    <nav class="settings-sidebar">
      <div class="sidebar-header">
        <h3>設定</h3>
      </div>
        <ul class="nav-menu">
          <li>
            <a href="#" class="nav-link active" data-section="profile">
              <i class="bi bi-person-circle"></i> プロフィール設定
            </a>
          </li>
          <li>
            <a href="#" class="nav-link" data-section="prompts">
              <i class="bi bi-shield-lock"></i> プロンプト管理
            </a>
          </li>
          <li>
            <a href="#" class="nav-link" data-section="prompt-list">
              <i class="bi bi-list-stars"></i> プロンプトリスト
            </a>
          </li>
          <li>
            <a href="#" class="nav-link" data-section="notifications">
              <i class="bi bi-bell"></i> 通知設定
            </a>
          </li>
          <li>
            <a href="#" class="nav-link" data-section="security">
              <i class="bi bi-key"></i> セキュリティ
            </a>
          </li>
        </ul>
      <div class="sidebar-footer">
        <p>&copy; 2025 YourApp</p>
      </div>
    </nav>

    <main class="settings-content">

<div class="mb-4">
  <button
    type="button"
    class="settings-back-btn"
    onclick="history.back()"
    title="戻る"
  >
    <i class="bi bi-arrow-left"></i>
  </button>
</div>

      <!-- プロフィール設定セクション -->
      <div id="profile-section" class="settings-section active">
        <div class="settings-card">
          <h2>ユーザープロフィール設定</h2>
          <form id="userSettingsForm">
            <div class="form-group avatar-group">
              <label class="form-label" for="avatarInput">プロフィール画像</label>
              <div class="avatar-preview-wrapper">
                <img
                  id="avatarPreview"
                  src="/static/user-icon.png"
                  alt="Avatar Preview"
                  class="avatar-preview"
                />
                <button
                  type="button"
                  class="change-avatar-btn"
                  id="changeAvatarBtn"
                  title="画像を変更"
                >
                  <i class="bi bi-pencil-fill"></i>
                </button>
              </div>
              <input type="file" id="avatarInput" accept="image/*" hidden />
            </div>

            <div class="form-group">
              <label class="form-label" for="username">ユーザー名</label>
              <input
                type="text"
                id="username"
                name="username"
                class="custom-form-control"
                placeholder="ユーザー名を入力"
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="email">メールアドレス</label>
              <input
                type="email"
                id="email"
                name="email"
                class="custom-form-control"
                placeholder="example@domain.com"
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="bio">自己紹介</label>
              <textarea
                id="bio"
                name="bio"
                rows="4"
                class="custom-form-control"
                placeholder="自己紹介を入力 (例: 趣味、好きなことなど)"
              ></textarea>
            </div>

            <div class="button-group">
              <button
              type="button"
              class="secondary-button"
              id="cancelBtn"
              title="キャンセル"
            >
              キャンセル
            </button>
              <button type="submit" class="primary-button">変更を保存</button>
            </div>
          </form>
        </div>
      </div>

      <!-- プロンプト管理セクション -->
      <div id="prompts-section" class="settings-section">
        <div class="settings-card">
          <h2>プロンプト管理</h2>
          <div class="header-bar">
            <h3 class="section-title">My Prompts</h3>
          </div>
          <div id="promptList" class="prompt-grid">
            <!-- プロンプトカードは JavaScript により動的に生成 -->
          </div>
        </div>
      </div>

      <!-- プロンプトリストセクション -->
      <div id="prompt-list-section" class="settings-section">
        <div class="settings-card">
          <h2>プロンプトリスト</h2>
          <div class="header-bar">
            <h3 class="section-title">Prompt List</h3>
          </div>
          <div id="promptListEntries" class="prompt-grid">
            <!-- プロンプトリストは JavaScript により動的に生成 -->
          </div>
        </div>
      </div>

      <!-- 通知設定セクション -->
      <div id="notifications-section" class="settings-section">
        <div class="settings-card">
          <h2>通知設定</h2>
          <p>通知設定機能は準備中です。</p>
        </div>
      </div>

      <!-- セキュリティセクション -->
      <div id="security-section" class="settings-section">
        <div class="settings-card">
          <h2>セキュリティ</h2>
          <div class="security-stack">
            <div class="security-panel">
              <h3>Passkeys</h3>
              <p id="passkeySupportStatus">このブラウザの対応状況を確認しています。</p>
              <div class="button-group">
                <button type="button" class="primary-button" id="registerPasskeyBtn">
                  この端末にPasskeyを追加
                </button>
                <button type="button" class="secondary-button" id="refreshPasskeysBtn">
                  一覧を更新
                </button>
              </div>
            </div>
            <div class="security-panel">
              <h3>登録済みPasskeys</h3>
              <div id="passkeyList" class="passkey-list">
                <p class="passkey-empty">まだPasskeyは登録されていません。</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <!-- 編集用モーダル -->
  <div id="editModal" class="modal" tabindex="-1">
    <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title"><i class="bi bi-pencil-square me-2"></i>プロンプト編集</h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">
          <form id="editForm" class="modal-form">
            <input type="hidden" id="editPromptId">
            <div class="form-group">
              <label for="editTitle" class="form-label">タイトル</label>
              <input type="text" class="form-control input-field" id="editTitle" required>
            </div>
            <div class="form-group">
              <label for="editCategory" class="form-label">カテゴリ</label>
              <input type="text" class="form-control input-field" id="editCategory" required>
            </div>
            <div class="form-group">
              <label for="editContent" class="form-label">内容</label>
              <textarea class="form-control input-field" id="editContent" rows="5" required></textarea>
            </div>
            <div class="form-group">
              <label for="editInputExamples" class="form-label">入力例</label>
              <textarea class="form-control input-field" id="editInputExamples" rows="3"></textarea>
            </div>
            <div class="form-group">
              <label for="editOutputExamples" class="form-label">出力例</label>
              <textarea class="form-control input-field" id="editOutputExamples" rows="3"></textarea>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn-primary w-100">
                <i class="bi bi-save me-2"></i>更新する
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
`;

export default function UserSettingsPage() {
  const [bootstrapReady, setBootstrapReady] = useState(false);

  useEffect(() => {
    document.body.classList.add("settings-page");
    return () => {
      document.body.classList.remove("settings-page");
    };
  }, []);

  useEffect(() => {
    if (bootstrapReady) {
      import("../scripts/entries/settings");
    }
  }, [bootstrapReady]);

  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ユーザー設定</title>
        <link rel="icon" type="image/webp" href="/static/favicon.webp" />
        <link rel="icon" type="image/png" href="/static/favicon.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png" />
        <link
          href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap"
          rel="stylesheet"
        />
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
          rel="stylesheet"
        />
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css"
          rel="stylesheet"
        />
        <style>{`
          .user-settings-page {
            min-height: 100vh;
            background: #f4f7f6;
          }
          .user-settings-layout {
            display: flex;
            min-height: 100vh;
          }
          .settings-sidebar {
            width: 260px;
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
          }
          .settings-content {
            flex: 1;
            margin-left: 260px;
            padding: 2rem;
          }
          .settings-section {
            display: none;
          }
          .settings-section.active {
            display: block;
          }
          .security-stack {
            display: grid;
            gap: 1rem;
          }
          .security-panel {
            padding: 1rem 1.1rem;
            border: 1px solid rgba(0, 0, 0, 0.08);
            border-radius: 16px;
            background: #fff;
          }
          .passkey-list {
            display: grid;
            gap: 0.75rem;
          }
          .passkey-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 1rem;
            padding: 0.9rem 1rem;
            border-radius: 14px;
            background: #f7faf8;
          }
          .passkey-meta {
            color: #5f6b66;
            font-size: 0.92rem;
            line-height: 1.5;
          }
          .passkey-empty {
            margin: 0;
            color: #5f6b66;
          }
          @media (max-width: 768px) {
            .user-settings-layout {
              flex-direction: column;
            }
            .settings-sidebar {
              width: 100%;
              position: static;
            }
            .settings-content {
              margin-left: 0;
              padding: 1.5rem;
            }
          }
        `}</style>
        <link rel="stylesheet" href="/static/css/pages/user_settings/index.bundle.css" />
      </Head>
      <div className="user-settings-page" dangerouslySetInnerHTML={{ __html: bodyMarkup }} />

      <Script
        src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"
        strategy="afterInteractive"
        onLoad={() => setBootstrapReady(true)}
      />
    </>
  );
}
