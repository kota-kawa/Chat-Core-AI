// chat_messages.ts – メッセージ描画／コピー／ボット表示
// --------------------------------------------------
// ※ DOMPurify が未ロードでも message_utils 側でテキスト描画にフォールバックする

type StreamingBotMessageHandle = {
  appendChunk: (chunk: string) => void;
  complete: () => void;
  showError: (message: string) => void;
};

const STICKY_SCROLL_BOTTOM_THRESHOLD_PX = 72;

function isScrollViewportNearBottom(container: HTMLElement, thresholdPx = STICKY_SCROLL_BOTTOM_THRESHOLD_PX) {
  const distanceToBottom = container.scrollHeight - (container.scrollTop + container.clientHeight);
  return distanceToBottom <= thresholdPx;
}

function getShouldStickToBottom(container: HTMLElement) {
  if (window.isChatViewportNearBottom) {
    return window.isChatViewportNearBottom(STICKY_SCROLL_BOTTOM_THRESHOLD_PX);
  }
  return isScrollViewportNearBottom(container);
}

function createBotMessageElements(options: { scrollToBottom?: boolean } = {}) {
  const { scrollToBottom = true } = options;
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
  if (scrollToBottom) {
    if (window.scrollMessageToBottom) {
      window.scrollMessageToBottom();
    } else if (window.scrollMessageToTop) {
      window.scrollMessageToTop(wrapper);
    }
  }

  return { wrapper, msg };
}

function renderBotMessageContent(target: HTMLElement, raw: string) {
  if (window.renderSanitizedHTML && window.formatLLMOutput) {
    window.renderSanitizedHTML(target, window.formatLLMOutput(raw));
  } else {
    window.setTextWithLineBreaks?.(target, raw);
  }
}

function renderBotMessage(
  wrapper: HTMLElement,
  msg: HTMLElement,
  raw: string,
  options: { scrollToBottom?: boolean } = {}
) {
  const { scrollToBottom = true } = options;
  renderBotMessageContent(msg, raw);
  if (scrollToBottom) {
    if (window.scrollMessageToBottom) {
      window.scrollMessageToBottom();
    } else if (window.scrollMessageToTop) {
      window.scrollMessageToTop(wrapper);
    }
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
  if (!window.chatMessages) return;
  const shouldStickToBottom = getShouldStickToBottom(window.chatMessages);
  const elements = createBotMessageElements({ scrollToBottom: shouldStickToBottom });
  if (!elements) return;
  const { wrapper, msg } = elements;
  msg.dataset.fullText = text;
  renderBotMessage(wrapper, msg, text, { scrollToBottom: shouldStickToBottom });
  if (window.saveMessageToLocalStorage) window.saveMessageToLocalStorage(text, "bot");
}

function startStreamingBotMessage(): StreamingBotMessageHandle | null {
  if (!window.chatMessages) return null;
  const scrollContainer = window.chatMessages;
  const shouldStickToBottomAtStart = getShouldStickToBottom(scrollContainer);
  const elements = createBotMessageElements({ scrollToBottom: shouldStickToBottomAtStart });
  if (!elements) return null;
  const { wrapper, msg } = elements;
  wrapper.classList.add("message-wrapper--streaming");
  msg.classList.add("bot-message--streaming");
  const formattedContent = document.createElement("div");
  formattedContent.className = "bot-message__formatted-stream";
  const streamTail = document.createElement("span");
  streamTail.className = "bot-message__stream-tail";
  msg.append(formattedContent, streamTail);

  let receivedRaw = "";
  let displayedRaw = "";
  let formattedRaw = "";
  let animationFrameId: number | null = null;
  let shouldForceMarkdownFlush = false;
  let lastMarkdownRenderAt = 0;
  let lastTypingFrameAt: number | null = null;
  let lastChunkReceivedAt: number | null = null;
  let typingCharsPerMs = 0.042;
  let isProgrammaticScroll = false;
  let shouldStickToBottom = shouldStickToBottomAtStart;
  let isCompleted = false;
  let isFinalized = false;

  const markdownRefreshCharInterval = 30;
  const markdownRefreshMaxDelayMs = 120;
  const minTypingCharsPerMs = 0.016;
  const maxTypingCharsPerMs = 0.22;
  const typingRateSmoothing = 0.28;
  const backlogSpeedupDivisor = 80;
  const maxBacklogSpeedup = 4;

  const handleScroll = () => {
    if (isProgrammaticScroll) return;
    shouldStickToBottom = getShouldStickToBottom(scrollContainer);
  };

  scrollContainer.addEventListener("scroll", handleScroll, { passive: true });

  const scrollStreamingViewport = (force = false) => {
    if (!force && !shouldStickToBottom) return;

    isProgrammaticScroll = true;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    isProgrammaticScroll = false;
    shouldStickToBottom = true;
  };

  const refreshStreamingMarkdown = (force = false) => {
    const pendingMarkdownChars = displayedRaw.length - formattedRaw.length;
    if (pendingMarkdownChars <= 0) return false;

    const now = performance.now();
    const shouldFlush = force
      || pendingMarkdownChars >= markdownRefreshCharInterval
      || displayedRaw.endsWith("\n")
      || displayedRaw.endsWith("。")
      || displayedRaw.endsWith(".")
      || now - lastMarkdownRenderAt >= markdownRefreshMaxDelayMs;

    if (!shouldFlush) return false;

    const nextFormattedRaw = displayedRaw;
    renderBotMessageContent(formattedContent, nextFormattedRaw);
    formattedRaw = nextFormattedRaw;
    lastMarkdownRenderAt = now;
    return true;
  };

  const clamp = (value: number, min: number, max: number) => {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  };

  const updateTypingRateFromChunk = (chunkText: string) => {
    const chunkLength = chunkText.length;
    if (chunkLength <= 0) return;

    const now = performance.now();
    if (lastChunkReceivedAt !== null) {
      const elapsedMs = Math.max(16, now - lastChunkReceivedAt);
      const observedCharsPerMs = chunkLength / elapsedMs;
      typingCharsPerMs = clamp(
        typingCharsPerMs * (1 - typingRateSmoothing) + observedCharsPerMs * typingRateSmoothing,
        minTypingCharsPerMs,
        maxTypingCharsPerMs
      );
    }
    lastChunkReceivedAt = now;
  };

  const advanceDisplayedText = (frameNow: number, forceAll = false) => {
    const pendingChars = receivedRaw.length - displayedRaw.length;
    if (pendingChars <= 0) {
      lastTypingFrameAt = frameNow;
      return 0;
    }

    if (forceAll) {
      displayedRaw = receivedRaw;
      lastTypingFrameAt = frameNow;
      return 0;
    }

    const previousFrameAt = lastTypingFrameAt ?? frameNow - 16;
    const elapsedMs = clamp(frameNow - previousFrameAt, 16, 120);
    lastTypingFrameAt = frameNow;

    const speedup = Math.min(maxBacklogSpeedup, 1 + pendingChars / backlogSpeedupDivisor);
    const charsToAdvance = Math.max(1, Math.floor(elapsedMs * typingCharsPerMs * speedup));
    displayedRaw = receivedRaw.slice(0, displayedRaw.length + Math.min(pendingChars, charsToAdvance));
    return receivedRaw.length - displayedRaw.length;
  };

  const renderStreamingText = (frameNow: number, forceMarkdown = false, forceAllChars = false) => {
    const remainingChars = advanceDisplayedText(frameNow, forceAllChars);
    const refreshedMarkdown = refreshStreamingMarkdown(forceMarkdown);
    streamTail.textContent = displayedRaw.slice(formattedRaw.length);
    msg.dataset.fullText = displayedRaw;
    scrollStreamingViewport(refreshedMarkdown);
    return remainingChars;
  };

  const finalizeMessage = () => {
    if (isFinalized) return;
    isFinalized = true;
    scrollContainer.removeEventListener("scroll", handleScroll);

    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }

    wrapper.classList.remove("message-wrapper--streaming");
    msg.classList.remove("bot-message--streaming");
    msg.dataset.fullText = receivedRaw;
    renderBotMessage(wrapper, msg, receivedRaw, { scrollToBottom: shouldStickToBottom });
    if (window.saveMessageToLocalStorage) window.saveMessageToLocalStorage(receivedRaw, "bot");
  };

  const scheduleAnimation = () => {
    if (animationFrameId !== null || isFinalized) return;
    animationFrameId = window.requestAnimationFrame((frameNow) => {
      animationFrameId = null;
      const forceAllChars = isCompleted;
      const remainingChars = renderStreamingText(frameNow, shouldForceMarkdownFlush, forceAllChars);
      shouldForceMarkdownFlush = false;

      if (isCompleted) {
        finalizeMessage();
        return;
      }

      if (remainingChars > 0) {
        scheduleAnimation();
      }
    });
  };

  return {
    appendChunk(chunkText: string) {
      if (!chunkText || isCompleted) return;
      receivedRaw += chunkText;
      updateTypingRateFromChunk(chunkText);
      shouldForceMarkdownFlush = false;
      scheduleAnimation();
    },
    complete() {
      if (isCompleted) return;
      isCompleted = true;
      shouldForceMarkdownFlush = true;
      scheduleAnimation();
    },
    showError(message: string) {
      if (!message) return;
      receivedRaw = receivedRaw ? `${receivedRaw}\n\nエラー: ${message}` : `エラー: ${message}`;
      isCompleted = true;
      shouldForceMarkdownFlush = true;
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
