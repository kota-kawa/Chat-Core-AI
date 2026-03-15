import Head from "next/head";
import { useEffect } from "react";
import defaultTasks from "../data/default_tasks.json";

type DefaultTask = {
  name?: string;
  prompt_template?: string;
  input_examples?: string;
  output_examples?: string;
};

function escapeHtml(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createInitialTaskCardsMarkup(tasks: DefaultTask[]) {
  return tasks
    .map((task) => {
      const taskName =
        typeof task.name === "string" && task.name.trim()
          ? task.name.trim()
          : task.name
            ? String(task.name)
            : "無題";
      const taskHeader = taskName;
      const promptTemplate = task.prompt_template || "プロンプトテンプレートはありません";
      const inputExamples = task.input_examples || "入力例がありません";
      const outputExamples = task.output_examples || "出力例がありません";

      return `
        <div class="task-wrapper">
          <div class="prompt-card"
            data-task="${escapeHtml(taskName)}"
            data-prompt_template="${escapeHtml(promptTemplate)}"
            data-input_examples="${escapeHtml(inputExamples)}"
            data-output_examples="${escapeHtml(outputExamples)}"
            data-is_default="true">
            <div class="header-container">
              <div class="task-header">${escapeHtml(taskHeader)}</div>
              <button type="button" class="btn btn-outline-success btn-md task-detail-toggle">
                <i class="bi bi-caret-down"></i>
              </button>
            </div>
          </div>
        </div>`;
    })
    .join("");
}

const initialTaskCardsMarkup = createInitialTaskCardsMarkup(defaultTasks as DefaultTask[]);

function createZodiacLoaderMarkup(loaderClass: string) {
  const links = Array.from({ length: 8 }, () => '<span class="constellation-loader__link"></span>').join("");
  const nodes = Array.from({ length: 8 }, () => '<span class="constellation-loader__node"></span>').join("");
  return `<div class="constellation-loader ${loaderClass}" aria-hidden="true">${links}${nodes}</div>`;
}

const bodyMarkup = `
<!-- 浮遊メニュー -->
  <action-menu></action-menu>

  <!-- 既存の settings-btn のすぐ下あたりに追加 -->
  <!-- 未ログイン時の認証ボタン -->
  <div id="auth-buttons" style="display:none; position:fixed; top:10px; right:10px; z-index: 2000;">
    <button id="login-btn" class="auth-btn">
      <i class="bi bi-person-circle"></i>
      <span>ログイン / 登録</span>
    </button>
  </div>


  <!-- ログイン後のユーザーアイコン -->
  <user-icon id="userIcon" style="display: none;"></user-icon>

  <div id="setup-container">
    <form class="setup-form" id="setup-form">
      <h2 style="text-align: center; margin-bottom: 1.5rem;">Chat Core</h2>
      <div class="form-group">
        <label class="form-label">現在の状況・作業環境（入力なしでもOK）</label>
        <textarea id="setup-info" rows="4" placeholder="例：大学生、リモートワーク中　／　自宅のデスク、周囲は静か"></textarea>
      </div>
      <div class="form-group">
        <label class="form-label">AIモデル選択</label>
        <select id="ai-model">
          <option value="openai/gpt-oss-20b" selected>Groq: openai/gpt-oss-20b（標準・推奨）</option>
          <option value="gemini-2.5-flash">gemini-2.5-flash（高速）</option>
        </select>
      </div>

      <!-- 画面中央モーダル -->
      <div
        id="io-modal"
        style="display: none;"
        role="dialog"
        aria-modal="true"
        aria-labelledby="taskDetailTitle"
        aria-hidden="true"
        tabindex="-1"
      >
        <div class="io-modal-content" id="io-modal-content">
          <!-- JS で入出力例をここに挿入 -->
        </div>
      </div>

      <div class="task-selection-header">
        <p id="task-selection-text">実行したいタスクを選択（クリックで即実行）</p>
        <button id="openNewPromptModal" class="circle-button new-prompt-modal-btn" type="button" title="新しいプロンプトを投稿" style="display:none;">
          <i class="bi bi-plus-lg"></i>
        </button>
        <!-- タスク編集ボタンは task_manager.js で後から追加され、CSSの order で中央に表示されます -->
      </div>

      <div class="task-selection tasks-collapsed" id="task-selection">${initialTaskCardsMarkup}</div>

      <!-- これまでのチャットを見るボタン -->
      <div style="text-align: center; margin-top: 0.2rem;">
        <button id="access-chat-btn" type="button" class="primary-button" style="display:none;">
          <i class="bi bi-chat-left-text"></i> これまでのチャットを見る
        </button>
      </div>
    </form>
  </div>

  <div id="chat-container" style="display: none;">
    <div class="chat-header">
      <div class="header-left">
        <button id="back-to-setup" class="icon-button" title="設定変更">
          <i class="bi bi-arrow-left"></i>
        </button>
        <span>Chat Core</span>
      </div>

      <div
        class="typing-indicator"
        id="typing-indicator"
        style="display: none;"
        role="status"
        aria-live="polite"
        aria-label="AIが応答を準備しています"
      >
        ${createZodiacLoaderMarkup("typing-indicator__constellation")}
      </div>
    </div>
    <div class="chat-main">
      <div class="sidebar" id="chat-room-sidebar">
        <button id="new-chat-btn" class="new-chat-btn">
          <i class="bi bi-plus-lg"></i> 新規チャット
        </button>
        <div id="chat-room-list"></div>
      </div>
      <div class="chat-area">

        <button id="sidebar-toggle" class="icon-button sidebar-toggle chat-sidebar-toggle" title="チャットルーム">
          <i class="bi bi-arrow-bar-right"></i>
        </button>

        <div class="chat-messages" id="chat-messages"></div>
        <div class="input-container">
          <div class="input-wrapper">
            <input type="text" id="user-input" placeholder="メッセージを入力..." />
            <button class="primary-button" id="send-btn">
              <i class="bi bi-send"></i>
            </button>
          </div>
        </div>
        <chat-action-menu></chat-action-menu>
      </div>
    </div>
  </div>

  <!-- 新規追加：新しいプロンプトモーダル -->
  <div id="newPromptModal" class="new-prompt-modal" style="display: none;">
    <div class="new-prompt-modal-content">
      <!-- 閉じるボタン -->
      <span class="new-modal-close-btn" id="newModalCloseBtn">&times;</span>
      <h2>新しいプロンプトを投稿</h2>
      <form class="new-post-form" id="newPostForm">
        <div class="form-group">
          <label for="new-prompt-title">タイトル</label>
          <input type="text" id="new-prompt-title" placeholder="プロンプトのタイトルを入力" required />
        </div>
        <div class="form-group">
          <label for="new-prompt-content">プロンプト内容</label>
          <textarea id="new-prompt-content" rows="5" placeholder="具体的なプロンプト内容を入力" required></textarea>
        </div>
        <!-- ガードレールチェック -->
        <div class="form-group">
          <label>
            <input type="checkbox" id="new-guardrail-checkbox" />
            入出力例を追加する
          </label>
        </div>
        <!-- ガードレールがONのときだけ表示される部分 -->
        <div id="new-guardrail-fields">
          <div class="form-group">
            <label for="new-prompt-input-example">入力例（プロンプト内容とは別にしてください）</label>
            <textarea id="new-prompt-input-example" rows="3" placeholder="例: 夏休みの思い出をテーマにした短いエッセイを書いてください。"></textarea>
          </div>
          <div class="form-group">
            <label for="new-prompt-output-example">出力例</label>
            <textarea id="new-prompt-output-example" rows="3" placeholder="例: 夏休みのある日、私は家族と一緒に海辺へ出かけました..."></textarea>
          </div>
        </div>
        <button type="submit" class="submit-btn">
          <i class="bi bi-upload"></i> 投稿する
        </button>
      </form>
    </div>
  </div>

  <!-- Task Edit Modal -->
  <div id="taskEditModal" class="custom-modal" style="display: none;">
    <div class="custom-modal-dialog">
      <div class="custom-modal-content">
        <div class="custom-modal-header">
          <h5 class="custom-modal-title">タスク編集</h5>
          <button type="button" class="custom-modal-close" id="closeTaskEditModal">×</button>
        </div>
        <div class="custom-modal-body">
          <form id="taskEditForm">
            <!-- タスク名 -->
            <div class="custom-form-group">
              <label for="taskName" class="custom-form-label"><span style="color: green;">タイトル</span></label>
              <input type="text" class="custom-form-control" id="taskName" name="name" placeholder="例：メール作成">
              <div class="custom-form-text">タスクの名前を入力してください。</div>
            </div>
            <!-- プロンプトテンプレート -->
            <div class="custom-form-group">
              <label for="promptTemplate" class="custom-form-label"><span
                  style="color: green;">プロンプトテンプレート</span></label>
              <textarea class="custom-form-control" id="promptTemplate" name="prompt_template" rows="2"
                placeholder="例：メール本文の書き出し..."></textarea>
              <div class="custom-form-text">タスク実行時に使用するプロンプトテンプレートです。</div>
            </div>
            <!-- 入力例 -->
            <div class="custom-form-group">
              <label for="inputExamples" class="custom-form-label"><span style="color: green;">入力例</span></label>
              <textarea class="custom-form-control" id="inputExamples" name="input_examples" rows="2"
                placeholder="例：今日の天気は？"></textarea>
              <div class="custom-form-text">ユーザーが入力する例です。</div>
            </div>
            <!-- 出力例 -->
            <div class="custom-form-group">
              <label for="outputExamples" class="custom-form-label"><span style="color: green;">出力例</span></label>
              <textarea class="custom-form-control" id="outputExamples" name="output_examples" rows="2"
                placeholder="例：晴れです。"></textarea>
              <div class="custom-form-text">タスク実行時の出力例です。</div>
            </div>

          </form>
        </div>
        <div class="custom-modal-footer">
          <button type="button" class="custom-btn-secondary" id="cancelTaskEditModal">キャンセル</button>
          <button type="button" class="custom-btn-primary" id="saveTaskChanges">保存</button>
        </div>
      </div>
    </div>
  </div>

  

  



  

  <!-- 共通ユーティリティ -->
  

  <!-- ★チャット機能(順序に注意) -->
  
  
  
  
  
  <!-- セットアップ -->
  
  <!-- 画面ロード時の初期化 -->
  
  <!-- タスク関連＋プロンプトモーダル -->
`;

export default function HomePage() {
  useEffect(() => {
    document.body.classList.add("chat-page");
    import("../scripts/entries/chat");
    return () => {
      document.body.classList.remove("chat-page");
      document.body.classList.remove("sidebar-visible");
    };
  }, []);

  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ChatCore-AI</title>
        <link rel="icon" type="image/webp" href="/static/favicon.webp" />
        <link rel="icon" type="image/png" href="/static/favicon.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png" />
        <link
          href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css"
          rel="stylesheet"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css"
        />
      </Head>
      <div className="chat-page-shell" dangerouslySetInnerHTML={{ __html: bodyMarkup }} />
    </>
  );
}
