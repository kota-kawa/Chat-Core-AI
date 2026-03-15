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
  wrapper.classList.add("message-wrapper--streaming");
  msg.classList.add("bot-message--streaming");

  let receivedRaw = "";
  let displayedRaw = "";
  let animationFrameId: number | null = null;
  let lastFrameAt: number | null = null;
  let revealCarry = 0;
  let lastScrollAt = 0;
  let isCompleted = false;
  let isFinalized = false;

  const streamingScrollInterval = 48;

  const scrollStreamingViewport = (force = false) => {
    if (!window.chatMessages) return;
    const now = performance.now();
    if (!force && now - lastScrollAt < streamingScrollInterval) {
      return;
    }
    lastScrollAt = now;
    window.chatMessages.scrollTop = window.chatMessages.scrollHeight;
  };

  const renderStreamingText = (forceScroll = false) => {
    msg.textContent = displayedRaw;
    msg.dataset.fullText = displayedRaw;
    scrollStreamingViewport(forceScroll);
  };

  const getNextSafeIndex = (text: string, start: number, charCount: number) => {
    let index = start;
    let remaining = charCount;

    while (index < text.length && remaining > 0) {
      const code = text.charCodeAt(index);
      index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
      remaining -= 1;
    }

    return index;
  };

  const finalizeMessage = () => {
    if (isFinalized) return;
    isFinalized = true;

    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    wrapper.classList.remove("message-wrapper--streaming");
    msg.classList.remove("bot-message--streaming");
    msg.dataset.fullText = receivedRaw;
    renderBotMessage(wrapper, msg, receivedRaw);
    if (window.saveMessageToLocalStorage) window.saveMessageToLocalStorage(receivedRaw, "bot");
  };

  const scheduleAnimation = () => {
    if (animationFrameId !== null || isFinalized) return;
    animationFrameId = window.requestAnimationFrame((timestamp) => {
      animationFrameId = null;

      const deltaMs = lastFrameAt === null ? 16 : Math.min(timestamp - lastFrameAt, 120);
      lastFrameAt = timestamp;

      const pendingChars = receivedRaw.length - displayedRaw.length;
      if (pendingChars > 0) {
        const charsPerSecond = Math.min(520, 44 + pendingChars * 2.6);
        revealCarry += (deltaMs * charsPerSecond) / 1000;

        let revealCount = Math.floor(revealCarry);
        if (revealCount < 1) revealCount = 1;
        revealCarry = Math.max(0, revealCarry - revealCount);

        const nextIndex = getNextSafeIndex(receivedRaw, displayedRaw.length, revealCount);
        if (nextIndex > displayedRaw.length) {
          displayedRaw = receivedRaw.slice(0, nextIndex);
          renderStreamingText();
        }
      }

      if (displayedRaw.length < receivedRaw.length) {
        scheduleAnimation();
        return;
      }

      revealCarry = 0;
      lastFrameAt = null;
      renderStreamingText(true);

      if (isCompleted) {
        finalizeMessage();
      }
    });
  };

  return {
    appendChunk(chunkText: string) {
      if (!chunkText || isCompleted) return;
      receivedRaw += chunkText;
      scheduleAnimation();
    },
    complete() {
      if (isCompleted) return;
      isCompleted = true;
      if (displayedRaw.length >= receivedRaw.length) {
        finalizeMessage();
        return;
      }
      scheduleAnimation();
    },
    showError(message: string) {
      if (!message) return;
      receivedRaw = receivedRaw ? `${receivedRaw}\n\nエラー: ${message}` : `エラー: ${message}`;
      isCompleted = true;
      if (displayedRaw.length >= receivedRaw.length) {
        finalizeMessage();
        return;
      }
      scheduleAnimation();
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
