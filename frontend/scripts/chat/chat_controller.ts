// chat_controller.ts – 送信ボタン／バックエンド通信
// --------------------------------------------------

type StreamEventPayload = {
  event: string;
  data: Record<string, unknown>;
};

function parseStreamEventBlock(block: string): StreamEventPayload | null {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return null;

  let event = "message";
  const dataLines: string[] = [];

  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  });

  if (dataLines.length === 0) return null;

  try {
    return {
      event,
      data: JSON.parse(dataLines.join("\n")) as Record<string, unknown>
    };
  } catch (error) {
    console.warn("Failed to parse stream event payload.", error, block);
    return null;
  }
}

async function consumeStreamingChatResponse(response: Response) {
  if (!response.body) {
    throw new Error("ストリーム応答を受信できませんでした。");
  }

  const streamHandle = window.startStreamingBotMessage?.();
  if (!streamHandle) {
    throw new Error("ストリーム描画を開始できませんでした。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let streamError: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    blocks.forEach((block) => {
      const parsed = parseStreamEventBlock(block);
      if (!parsed) return;

      if (parsed.event === "chunk") {
        streamHandle.appendChunk(typeof parsed.data.text === "string" ? parsed.data.text : "");
        return;
      }

      if (parsed.event === "done") {
        completed = true;
        streamHandle.complete();
        return;
      }

      if (parsed.event === "error") {
        streamError = typeof parsed.data.message === "string"
          ? parsed.data.message
          : "ストリーム生成中にエラーが発生しました。";
      }
    });

    if (streamError) {
      streamHandle.showError(streamError);
      break;
    }

    if (done) break;
  }

  if (!completed && !streamError) {
    streamHandle.showError("ストリームが途中で終了しました。");
  }
}

/* 送信ボタン or Enter 押下 */
function sendMessage() {
  if (!window.userInput) return;
  const message = window.userInput.value.trim();
  if (!message) return;
  const aiModel = window.aiModelSelect ? window.aiModelSelect.value : "openai/gpt-oss-20b";
  window.showTypingIndicator?.();
  generateResponse(message, aiModel);
  window.userInput.value = "";
  window.userInput.style.height = "auto";
}

/* サーバー POST → Bot 応答を描画 */
async function generateResponse(message: string, aiModel: string) {
  if (!window.chatMessages) return;
  // marked の遅延読み込みを先行して開始し、初回描画の崩れを減らす
  window.formatLLMOutput?.("");
  // ユーザーメッセージを即描画
  window.renderUserMessage?.(message);

  // Bot 側スピナー
  const spinnerWrap = document.createElement("div");
  spinnerWrap.className = "message-wrapper bot-message-wrapper";
  const spinner = document.createElement("div");
  spinner.className = "bot-message";
  spinner.innerHTML = '<div class="spinner"></div>';
  spinnerWrap.appendChild(spinner);

  window.chatMessages.appendChild(spinnerWrap);
  if (window.scrollMessageToBottom) {
    window.scrollMessageToBottom();
  } else if (window.scrollMessageToTop) {
    window.scrollMessageToTop(spinnerWrap);
  }

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        chat_room_id: window.currentChatRoomId,
        model: aiModel
      })
    });
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      window.hideTypingIndicator?.();
      spinnerWrap.remove();
      await consumeStreamingChatResponse(response);
      return;
    }

    const data = await response.json();
    window.hideTypingIndicator?.();
    spinnerWrap.remove();
    if (data && data.response) {
      window.renderBotMessageImmediate?.(data.response);
    } else if (data && data.error) {
      window.renderBotMessageImmediate?.("エラー: " + data.error);
    } else {
      window.renderBotMessageImmediate?.("エラー: 予期しないエラーが発生しました。");
    }
  } catch (err) {
    window.hideTypingIndicator?.();
    spinnerWrap.remove();
    const errorMessage = err instanceof Error ? err.message : String(err);
    window.renderBotMessageImmediate?.("エラー: " + errorMessage);
  }
}

// ---- window へ公開 ------------------------------
window.sendMessage = sendMessage;
window.generateResponse = generateResponse;

export {};
