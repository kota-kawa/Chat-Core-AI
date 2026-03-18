import Head from "next/head";
import { useEffect } from "react";

const bodyMarkup = `
  <action-menu></action-menu>

  <div id="auth-buttons" style="display:none; position:fixed; top:10px; right:10px; z-index: 2000;">
    <button id="login-btn" class="auth-btn">
      <i class="bi bi-person-circle"></i>
      <span>ログイン / 登録</span>
    </button>
  </div>

  <user-icon id="userIcon" style="display:none;"></user-icon>

  <header class="prompts-header" aria-labelledby="promptShareHeroTitle">
    <div class="prompts-header__inner">
      <p class="hero-kicker">Prompt Marketplace</p>
      <h1 id="promptShareHeroTitle" class="hero-title">使えるプロンプトを、すぐ見つける。</h1>
      <p class="hero-description">
        実務で使えるテンプレートを検索・保存・共有。チームのナレッジを、カード形式で直感的に管理できます。
      </p>

      <div class="hero-actions">
        <button type="button" id="heroOpenPostModal" class="hero-action hero-action--primary">
          <i class="bi bi-plus-circle"></i>
          <span>新しいプロンプトを投稿</span>
        </button>
        <a href="#prompt-feed-section" id="heroBrowsePrompts" class="hero-action hero-action--secondary">
          <i class="bi bi-compass"></i>
          <span>一覧を閲覧する</span>
        </a>
      </div>

      <ul class="hero-highlights" aria-label="このページの特徴">
        <li><i class="bi bi-lightning-charge-fill"></i><span>高速検索</span></li>
        <li><i class="bi bi-collection"></i><span>カテゴリ整理</span></li>
        <li><i class="bi bi-bookmark-check-fill"></i><span>ワンクリック保存</span></li>
      </ul>

      <div class="search-section" role="search" aria-label="プロンプト検索">
        <div class="search-box">
          <input type="text" id="searchInput" placeholder="キーワードでプロンプトを検索..." />
          <button id="searchButton" type="button" aria-label="検索を実行する">
            <i class="bi bi-search"></i>
          </button>
        </div>
      </div>
    </div>
  </header>

  <main>
    <section class="categories" aria-labelledby="categories-title">
      <div class="section-header">
        <p class="section-kicker">Browse</p>
        <h2 id="categories-title">カテゴリ一覧</h2>
        <p class="section-description">気になるテーマを選ぶと、プロンプトを絞り込めます。</p>
      </div>
      <div class="category-list">
        <button type="button" class="category-card active" data-category="all">
          <i class="bi bi-grid"></i>
          <span>全て</span>
        </button>
        <button type="button" class="category-card" data-category="恋愛">
          <i class="bi bi-heart-fill"></i>
          <span>恋愛</span>
        </button>
        <button type="button" class="category-card" data-category="勉強">
          <i class="bi bi-book"></i>
          <span>勉強</span>
        </button>
        <button type="button" class="category-card" data-category="趣味">
          <i class="bi bi-camera"></i>
          <span>趣味</span>
        </button>
        <button type="button" class="category-card" data-category="仕事">
          <i class="bi bi-briefcase"></i>
          <span>仕事</span>
        </button>
        <button type="button" class="category-card" data-category="その他">
          <i class="bi bi-stars"></i>
          <span>その他</span>
        </button>
        <button type="button" class="category-card" data-category="スポーツ">
          <i class="bi bi-trophy"></i>
          <span>スポーツ</span>
        </button>
        <button type="button" class="category-card" data-category="音楽">
          <i class="bi bi-music-note"></i>
          <span>音楽</span>
        </button>
        <button type="button" class="category-card" data-category="旅行">
          <i class="bi bi-geo-alt"></i>
          <span>旅行</span>
        </button>
        <button type="button" class="category-card" data-category="グルメ">
          <i class="bi bi-shop"></i>
          <span>グルメ</span>
        </button>
      </div>
    </section>

    <section id="prompt-feed-section" class="prompts-list" aria-labelledby="selected-category-title">
      <div class="section-header prompts-list-header">
        <p class="section-kicker">Prompt Feed</p>
        <h2 id="selected-category-title">全てのプロンプト</h2>
        <p class="section-description">カードをクリックすると詳細を確認できます。</p>
      </div>
      <div class="prompt-toolbar">
        <p id="promptCountMeta" class="prompt-count-meta">公開プロンプトを読み込み中...</p>
      </div>
      <div id="promptResults"></div>
      <div class="prompt-cards">
        <p class="prompt-loading-message">読み込み中...</p>
      </div>
    </section>
  </main>

  <!-- 投稿モーダル -->
  <div id="postModal" class="post-modal" role="dialog" aria-modal="true" aria-labelledby="postModalTitle" aria-hidden="true">
    <div class="post-modal-content post-modal-content--composer" tabindex="-1">
      <button type="button" class="close-btn" aria-label="投稿モーダルを閉じる">&times;</button>
      <h2 id="postModalTitle">新しいプロンプトを投稿</h2>
      <p class="post-modal-lead">みんなの役に立つプロンプトを、分かりやすく共有しましょう。</p>
      <form class="post-form" id="postForm">

        <div class="form-group">
          <label for="prompt-title">タイトル</label>
          <input type="text" id="prompt-title" placeholder="プロンプトのタイトルを入力" required />
        </div>
        <div class="form-group">

          <label for="prompt-category">カテゴリ</label>
          <select id="prompt-category" required>
            <option value="未選択" selected>未選択</option>
            <option value="恋愛">恋愛</option>
            <option value="勉強">勉強</option>
            <option value="趣味">趣味</option>
            <option value="仕事">仕事</option>
            <option value="その他">その他</option>
            <option value="スポーツ">スポーツ</option>
            <option value="音楽">音楽</option>
            <option value="旅行">旅行</option>
            <option value="グルメ">グルメ</option>
          </select>
        </div>
        <div class="form-group">
          <label for="prompt-content">プロンプト内容</label>
          <textarea id="prompt-content" rows="5" placeholder="具体的なプロンプト内容を入力" required></textarea>
        </div>
        <div class="form-group">
          <label for="prompt-author">投稿者名</label>
          <input type="text" id="prompt-author" placeholder="ニックネームなど" value="アイデア職人" required />
        </div>
        <!-- ガードレールの使用チェック -->
        <div class="form-group">
          <label>
            <input type="checkbox" id="guardrail-checkbox"> 入出力例を追加する
          </label>
        </div>

        <!-- ガードレールチェック時に表示する入力例・出力例のフィールド -->
        <div id="guardrail-fields" style="display: none;">
          <div class="form-group">
            <label for="prompt-input-example">入力例（プロンプト内容とは別にしてください）</label>
            <textarea id="prompt-input-example" rows="3" placeholder="例: 夏休みの思い出をテーマにした短いエッセイを書いてください。"></textarea>
          </div>
          <div class="form-group">
            <label for="prompt-output-example">出力例</label>
            <textarea id="prompt-output-example" rows="3"
              placeholder="例: 夏休みのある日、私は家族と一緒に海辺へ出かけました。波の音と潮風に包まれながら、子供の頃の記憶がよみがえり、心が温かくなりました。その日は一生忘れられない、宝物のような時間となりました。"></textarea>
          </div>
        </div>

        <button type="submit" class="submit-btn">
          <i class="bi bi-upload"></i> 投稿する
        </button>
      </form>
    </div>
  </div>

  <!-- プロンプト詳細モーダル -->
  <div id="promptDetailModal" class="post-modal" role="dialog" aria-modal="true" aria-labelledby="modalPromptTitle" aria-hidden="true">
    <div class="post-modal-content" tabindex="-1">
      <button type="button" class="close-btn" id="closePromptDetailModal" aria-label="詳細モーダルを閉じる">&times;</button>
      <h2 id="modalPromptTitle">プロンプト詳細</h2>
      <div class="modal-content-body">
        <div class="form-group">
          <label><strong>カテゴリ:</strong></label>
          <p id="modalPromptCategory"></p>
        </div>
        <div class="form-group">
          <label><strong>内容:</strong></label>
          <p id="modalPromptContent"></p>
        </div>
        <div class="form-group">
          <label><strong>投稿者:</strong></label>
          <p id="modalPromptAuthor"></p>
        </div>
        <div id="modalInputExamplesGroup" class="form-group" style="display: none;">
          <label><strong>入力例:</strong></label>
          <p id="modalInputExamples"></p>
        </div>
        <div id="modalOutputExamplesGroup" class="form-group" style="display: none;">
          <label><strong>出力例:</strong></label>
          <p id="modalOutputExamples"></p>
        </div>
      </div>
    </div>
  </div>

  <!-- 新規投稿ボタン -->
  <button id="openPostModal" class="new-prompt-btn" aria-label="新しいプロンプトを投稿">
    <i class="bi bi-plus-lg"></i>
  </button>

  <!-- メインのJavaScript -->
`;

export default function PromptSharePage() {
  useEffect(() => {
    document.body.classList.add("prompt-share-page");
    const w = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let setupTimerId: number | null = null;
    let idleId: number | null = null;

    if (typeof w.requestIdleCallback === "function") {
      idleId = w.requestIdleCallback(
        () => {
          void import("../../scripts/entries/prompt_share");
        },
        { timeout: 500 }
      );
    } else {
      setupTimerId = window.setTimeout(() => {
        void import("../../scripts/entries/prompt_share");
      }, 0);
    }

    return () => {
      if (idleId !== null && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(idleId);
      }
      if (setupTimerId !== null) {
        clearTimeout(setupTimerId);
      }
      document.documentElement.classList.remove("ps-modal-open");
      document.body.classList.remove("ps-modal-open");
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.left = "";
      document.body.style.right = "";
      document.body.style.width = "";
      document.body.classList.remove("prompt-share-page");
    };
  }, []);

  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>プロンプト共有 - トップ</title>
        <link rel="icon" type="image/webp" href="/static/favicon.webp" />
        <link rel="icon" type="image/png" href="/static/favicon.png" />
        <link rel="dns-prefetch" href="https://cdn.jsdelivr.net" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css"
        />
      </Head>
      <div className="prompt-share-page" dangerouslySetInnerHTML={{ __html: bodyMarkup }} />
    </>
  );
}
