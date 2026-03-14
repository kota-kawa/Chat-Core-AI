// chat_messages.ts – メッセージ描画／コピー／ボット表示
// --------------------------------------------------
// ※ DOMPurify が未ロードでも message_utils 側でテキスト描画にフォールバックする

type StreamingBotMessageHandle = {
  appendChunk: (chunk: string) => void;
  complete: () => void;
  showError: (message: string) => void;
};

function createBotMessageElements() {
  if (!window.chatMessages) return null;
  const wrapper = document.createElement("div");
  wrapper.className = "message-wrapper bot-message-wrapper";

  const msg = document.createElement("div");
  msg.className = "bot-message";

  const copyBtn = window.createCopyBtn
    ? window.createCopyBtn(() => msg.dataset.fullText || "")
    : document.createElement("button");

  wrapper.append(copyBtn, msg);
  window.chatMessages.appendChild(wrapper);
  if (window.scrollMessageToBottom) {
    window.scrollMessageToBottom();
  } else if (window.scrollMessageToTop) {
    window.scrollMessageToTop(wrapper);
  }

  return { wrapper, msg };
}

function renderBotMessage(wrapper: HTMLElement, msg: HTMLElement, raw: string) {
  if (window.renderSanitizedHTML && window.formatLLMOutput) {
    window.renderSanitizedHTML(msg, window.formatLLMOutput(raw));
  } else {
    window.setTextWithLineBreaks?.(msg, raw);
  }

  if (window.scrollMessageToBottom) {
    window.scrollMessageToBottom();
  } else if (window.scrollMessageToTop) {
    window.scrollMessageToTop(wrapper);
  }
}

////////////////////////////////////////////////////////////////////////////////
// メッセージ描画
////////////////////////////////////////////////////////////////////////////////

/* ユーザーメッセージを即時描画 */
function renderUserMessage(text: string) {
  if (!window.chatMessages) return;
  const wrapper = document.createElement("div");
  wrapper.className = "message-wrapper user-message-wrapper";

  const msg = document.createElement("div");
  msg.className = "user-message";

  // テキスト → <br> 置換後、<br> だけ許可してサニタイズ描画
  const htmlText = text.replace(/\n/g, "<br>");
  window.renderSanitizedHTML?.(msg, htmlText, ["br"]);
  msg.style.animation = "floatUp 0.5s ease-out";

  const copyBtn = window.createCopyBtn ? window.createCopyBtn(() => text) : document.createElement("button");

  wrapper.append(copyBtn, msg);
  window.chatMessages.appendChild(wrapper);
  if (window.scrollMessageToBottom) {
    window.scrollMessageToBottom();
  } else if (window.scrollMessageToTop) {
    window.scrollMessageToTop(wrapper);
  }

  // ローカル保存は <br> 付き HTML で互換維持
  if (window.saveMessageToLocalStorage) window.saveMessageToLocalStorage(htmlText, "user");
}

/* Bot メッセージを即時描画 */
function renderBotMessageImmediate(text: string) {
  const elements = createBotMessageElements();
  if (!elements) return;
  const { wrapper, msg } = elements;
  msg.dataset.fullText = text;
  renderBotMessage(wrapper, msg, text);
  if (window.saveMessageToLocalStorage) window.saveMessageToLocalStorage(text, "bot");
}

function startStreamingBotMessage(): StreamingBotMessageHandle | null {
  const elements = createBotMessageElements();
  if (!elements) return null;
  const { wrapper, msg } = elements;

  let raw = "";
  let lastRenderAt = 0;
  let renderTimer: number | null = null;
  const renderInterval = 60;
  let isCompleted = false;

  const renderMarkdown = (force = false) => {
    if (renderTimer !== null) {
      window.clearTimeout(renderTimer);
      renderTimer = null;
    }

    const now = Date.now();
    if (!force && now - lastRenderAt < renderInterval) {
      renderTimer = window.setTimeout(() => renderMarkdown(true), renderInterval - (now - lastRenderAt));
      return;
    }

    renderBotMessage(wrapper, msg, raw);
    lastRenderAt = now;
  };

  return {
    appendChunk(chunkText: string) {
      if (!chunkText || isCompleted) return;
      raw += chunkText;
      msg.dataset.fullText = raw;
      renderMarkdown();
    },
    complete() {
      if (isCompleted) return;
      isCompleted = true;
      msg.dataset.fullText = raw;
      renderMarkdown(true);
      if (window.saveMessageToLocalStorage) window.saveMessageToLocalStorage(raw, "bot");
    },
    showError(message: string) {
      if (!message) return;
      raw = raw ? `${raw}\n\nエラー: ${message}` : `エラー: ${message}`;
      msg.dataset.fullText = raw;
      isCompleted = true;
      renderMarkdown(true);
      if (window.saveMessageToLocalStorage) window.saveMessageToLocalStorage(raw, "bot");
    }
  };
}

/* ローカル／サーバ履歴共通描画 */
function displayMessage(text: string, sender: string) {
  if (!window.chatMessages) return;
  const wrapper = document.createElement("div");
  const copyBtn = window.createCopyBtn ? window.createCopyBtn(() => text) : document.createElement("button");

  if (sender === "user") {
    wrapper.className = "message-wrapper user-message-wrapper";
    const msg = document.createElement("div");
    msg.className = "user-message";

    // 既存履歴は <br> が含まれているため、<br> だけ許可して描画
    if (text.includes("<")) {
      window.renderSanitizedHTML?.(msg, text, ["br"]);
    } else {
      window.setTextWithLineBreaks?.(msg, text);
    }

    wrapper.append(copyBtn, msg);
  } else {
    wrapper.className = "message-wrapper bot-message-wrapper";
    const msg = document.createElement("div");
    msg.className = "bot-message";

    // Bot はマークアップ済み → 広めのタグ許可でサニタイズ
    if (window.renderSanitizedHTML && window.formatLLMOutput) {
      window.renderSanitizedHTML(msg, window.formatLLMOutput(text));
    }
    wrapper.append(copyBtn, msg);
  }
  window.chatMessages.appendChild(wrapper);
  if (window.scrollMessageToBottom) {
    window.scrollMessageToBottom();
  } else if (window.scrollMessageToTop) {
    window.scrollMessageToTop(wrapper);
  }
}

// ---- window へ公開 ------------------------------
window.renderUserMessage = renderUserMessage;
window.renderBotMessageImmediate = renderBotMessageImmediate;
window.startStreamingBotMessage = startStreamingBotMessage;
window.displayMessage = displayMessage;

export {};
