// chat_controller.ts – 送信ボタン／バックエンド通信
// --------------------------------------------------

type StreamEventPayload = {
  event: string;
  data: Record<string, unknown>;
};

type StreamingBotMessageHandle = {
  appendChunk: (chunk: string) => void;
  complete: () => void;
  showError: (message: string) => void;
};

type ZodiacNode = {
  x: number;
  y: number;
  size?: number;
};

type ZodiacConstellation = {
  name: string;
  nodes: ZodiacNode[];
  links: Array<[number, number]>;
};

const ZODIAC_NODE_COUNT = 8;
const ZODIAC_LINK_COUNT = 8;
const ZODIAC_STEP_MS = 2400;
const ZODIAC_SYNC_MS = 180;
const ZODIAC_CONSTELLATIONS: ZodiacConstellation[] = [
  {
    name: "牡羊座",
    nodes: [
      { x: 22, y: 58, size: 0.92 },
      { x: 37, y: 36, size: 1 },
      { x: 51, y: 49, size: 0.86 },
      { x: 67, y: 34, size: 1.08 },
      { x: 80, y: 46, size: 0.78 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4]]
  },
  {
    name: "牡牛座",
    nodes: [
      { x: 20, y: 48, size: 0.82 },
      { x: 31, y: 28, size: 0.94 },
      { x: 45, y: 50, size: 1.08 },
      { x: 59, y: 28, size: 0.94 },
      { x: 72, y: 48, size: 0.82 },
      { x: 52, y: 68, size: 0.9 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5]]
  },
  {
    name: "双子座",
    nodes: [
      { x: 24, y: 24, size: 0.82 },
      { x: 24, y: 72, size: 0.82 },
      { x: 42, y: 22, size: 0.94 },
      { x: 42, y: 72, size: 0.94 },
      { x: 60, y: 26, size: 0.82 },
      { x: 60, y: 68, size: 0.82 },
      { x: 78, y: 24, size: 0.94 },
      { x: 78, y: 68, size: 0.94 }
    ],
    links: [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [2, 4], [4, 6], [1, 3]]
  },
  {
    name: "蟹座",
    nodes: [
      { x: 26, y: 50, size: 0.88 },
      { x: 36, y: 34, size: 0.82 },
      { x: 50, y: 36, size: 1 },
      { x: 60, y: 50, size: 0.88 },
      { x: 48, y: 66, size: 0.9 },
      { x: 30, y: 64, size: 0.82 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]
  },
  {
    name: "獅子座",
    nodes: [
      { x: 22, y: 56, size: 0.86 },
      { x: 33, y: 39, size: 0.92 },
      { x: 46, y: 30, size: 1.06 },
      { x: 60, y: 38, size: 0.92 },
      { x: 56, y: 56, size: 0.84 },
      { x: 70, y: 68, size: 0.92 },
      { x: 82, y: 56, size: 0.82 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]
  },
  {
    name: "乙女座",
    nodes: [
      { x: 20, y: 28, size: 0.82 },
      { x: 30, y: 66, size: 0.9 },
      { x: 42, y: 34, size: 0.84 },
      { x: 54, y: 64, size: 0.96 },
      { x: 66, y: 38, size: 0.84 },
      { x: 76, y: 60, size: 0.9 },
      { x: 86, y: 74, size: 0.8 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]
  },
  {
    name: "天秤座",
    nodes: [
      { x: 20, y: 62, size: 0.78 },
      { x: 38, y: 62, size: 0.88 },
      { x: 56, y: 62, size: 1.02 },
      { x: 74, y: 62, size: 0.78 },
      { x: 38, y: 42, size: 0.82 },
      { x: 56, y: 34, size: 0.94 },
      { x: 74, y: 42, size: 0.82 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [1, 4], [4, 5], [5, 6], [6, 2]]
  },
  {
    name: "蠍座",
    nodes: [
      { x: 18, y: 28, size: 0.8 },
      { x: 30, y: 42, size: 0.86 },
      { x: 42, y: 34, size: 0.82 },
      { x: 54, y: 48, size: 0.92 },
      { x: 66, y: 40, size: 0.82 },
      { x: 78, y: 56, size: 0.9 },
      { x: 88, y: 68, size: 1 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]
  },
  {
    name: "射手座",
    nodes: [
      { x: 22, y: 60, size: 0.84 },
      { x: 40, y: 42, size: 1 },
      { x: 58, y: 24, size: 0.82 },
      { x: 58, y: 60, size: 0.88 },
      { x: 76, y: 42, size: 0.92 },
      { x: 88, y: 26, size: 0.82 },
      { x: 78, y: 74, size: 0.78 }
    ],
    links: [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [4, 6]]
  },
  {
    name: "山羊座",
    nodes: [
      { x: 20, y: 34, size: 0.84 },
      { x: 34, y: 64, size: 0.94 },
      { x: 46, y: 36, size: 0.82 },
      { x: 60, y: 60, size: 1.02 },
      { x: 74, y: 38, size: 0.84 },
      { x: 82, y: 54, size: 0.88 },
      { x: 90, y: 70, size: 0.78 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]
  },
  {
    name: "水瓶座",
    nodes: [
      { x: 18, y: 40, size: 0.78 },
      { x: 30, y: 28, size: 0.88 },
      { x: 42, y: 42, size: 0.82 },
      { x: 54, y: 30, size: 0.92 },
      { x: 66, y: 44, size: 0.82 },
      { x: 78, y: 32, size: 0.88 },
      { x: 90, y: 46, size: 0.78 }
    ],
    links: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]]
  },
  {
    name: "魚座",
    nodes: [
      { x: 16, y: 30, size: 0.78 },
      { x: 30, y: 44, size: 0.9 },
      { x: 16, y: 58, size: 0.78 },
      { x: 44, y: 44, size: 1 },
      { x: 58, y: 44, size: 0.88 },
      { x: 84, y: 30, size: 0.78 },
      { x: 70, y: 44, size: 0.9 },
      { x: 84, y: 58, size: 0.78 }
    ],
    links: [[0, 1], [1, 2], [1, 3], [3, 4], [4, 6], [6, 5], [6, 7]]
  }
];

const activeZodiacLoaders = new Set<HTMLElement>();
let zodiacLoopId: number | null = null;
let zodiacResizeBound = false;

function getCurrentZodiacIndex() {
  return Math.floor(Date.now() / ZODIAC_STEP_MS) % ZODIAC_CONSTELLATIONS.length;
}

function getLoaderMetrics(loader: HTMLElement) {
  const rect = loader.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { width: rect.width, height: rect.height };
  }

  if (loader.classList.contains("typing-indicator__constellation")) {
    return { width: 126, height: 45 };
  }

  return { width: 206, height: 86 };
}

function applyZodiacConstellation(loader: HTMLElement, zodiacIndex: number) {
  const constellation = ZODIAC_CONSTELLATIONS[zodiacIndex];
  const nodes = Array.from(loader.querySelectorAll<HTMLElement>(".constellation-loader__node"));
  const links = Array.from(loader.querySelectorAll<HTMLElement>(".constellation-loader__link"));
  const { width, height } = getLoaderMetrics(loader);
  const baseNodeSize = Math.max(4, width * 0.03);

  nodes.forEach((node, index) => {
    const config = constellation.nodes[index];

    if (!config) {
      node.style.left = "50%";
      node.style.top = "50%";
      node.style.width = "0px";
      node.style.height = "0px";
      node.style.opacity = "0";
      node.style.transform = "translate(-50%, -50%) scale(0.32)";
      return;
    }

    const nodeSize = baseNodeSize * (config.size || 1);
    node.style.left = `${config.x}%`;
    node.style.top = `${config.y}%`;
    node.style.width = `${nodeSize}px`;
    node.style.height = `${nodeSize}px`;
    node.style.opacity = "1";
    node.style.transform = "translate(-50%, -50%) scale(1)";
  });

  links.forEach((link, index) => {
    const config = constellation.links[index];

    if (!config) {
      link.style.left = "50%";
      link.style.top = "50%";
      link.style.width = "0px";
      link.style.opacity = "0";
      link.style.transform = "translateY(-50%) rotate(0deg)";
      return;
    }

    const start = constellation.nodes[config[0]];
    const end = constellation.nodes[config[1]];

    if (!start || !end) {
      link.style.width = "0px";
      link.style.opacity = "0";
      return;
    }

    const dx = ((end.x - start.x) / 100) * width;
    const dy = ((end.y - start.y) / 100) * height;
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    const length = Math.hypot(dx, dy);

    link.style.left = `${start.x}%`;
    link.style.top = `${start.y}%`;
    link.style.width = `${length}px`;
    link.style.opacity = "1";
    link.style.transform = `translateY(-50%) rotate(${angle}deg)`;
  });

  loader.dataset.zodiacIndex = String(zodiacIndex);
  loader.dataset.zodiacName = constellation.name;
  loader.dataset.zodiacSizeKey = `${Math.round(width)}x${Math.round(height)}`;
}

function syncZodiacLoaders(forceCurrent = false) {
  const zodiacIndex = getCurrentZodiacIndex();

  activeZodiacLoaders.forEach((loader) => {
    if (!loader.isConnected) {
      activeZodiacLoaders.delete(loader);
      return;
    }

    const currentIndex = Number(loader.dataset.zodiacIndex ?? "-1");
    const sizeKey = (() => {
      const { width, height } = getLoaderMetrics(loader);
      return `${Math.round(width)}x${Math.round(height)}`;
    })();

    if (forceCurrent || currentIndex !== zodiacIndex || loader.dataset.zodiacSizeKey !== sizeKey) {
      applyZodiacConstellation(loader, zodiacIndex);
    }
  });

  if (activeZodiacLoaders.size === 0 && zodiacLoopId !== null) {
    window.clearInterval(zodiacLoopId);
    zodiacLoopId = null;
    if (zodiacResizeBound) {
      window.removeEventListener("resize", handleZodiacResize);
      zodiacResizeBound = false;
    }
  }
}

function handleZodiacResize() {
  syncZodiacLoaders(true);
}

function ensureZodiacLoop() {
  if (zodiacLoopId === null) {
    zodiacLoopId = window.setInterval(() => {
      syncZodiacLoaders(false);
    }, ZODIAC_SYNC_MS);
  }

  if (!zodiacResizeBound) {
    window.addEventListener("resize", handleZodiacResize);
    zodiacResizeBound = true;
  }
}

function setupZodiacLoader(loader: HTMLElement) {
  if (loader.dataset.zodiacReady === "true") return;

  loader.dataset.zodiacReady = "true";
  activeZodiacLoaders.add(loader);

  Array.from(loader.querySelectorAll<HTMLElement>(".constellation-loader__node")).forEach((node, index) => {
    node.style.setProperty("--node-delay", `${index * -0.18}s`);
  });

  Array.from(loader.querySelectorAll<HTMLElement>(".constellation-loader__link")).forEach((link, index) => {
    link.style.setProperty("--link-delay", `${index * -0.16}s`);
  });

  applyZodiacConstellation(loader, getCurrentZodiacIndex());
  ensureZodiacLoop();

  window.requestAnimationFrame(() => {
    loader.classList.add("is-ready");
    syncZodiacLoaders(true);
  });
}

function appendConstellationLoader(parent: HTMLElement, modifierClass: string) {
  const loader = document.createElement("div");
  loader.className = `constellation-loader ${modifierClass}`;
  loader.setAttribute("aria-hidden", "true");

  for (let index = 1; index <= ZODIAC_LINK_COUNT; index += 1) {
    const link = document.createElement("span");
    link.className = "constellation-loader__link";
    loader.appendChild(link);
  }

  for (let index = 1; index <= ZODIAC_NODE_COUNT; index += 1) {
    const node = document.createElement("span");
    node.className = "constellation-loader__node";
    loader.appendChild(node);
  }

  parent.appendChild(loader);
  return loader;
}

function createThinkingPlaceholder() {
  if (!window.chatMessages) return null;

  const wrapper = document.createElement("div");
  wrapper.className = "message-wrapper bot-message-wrapper thinking-message-wrapper";

  const thinking = document.createElement("div");
  thinking.className = "thinking-message";
  thinking.setAttribute("role", "status");
  thinking.setAttribute("aria-live", "polite");
  thinking.setAttribute("aria-label", "AIが応答を準備しています");

  const loader = appendConstellationLoader(thinking, "thinking-message__constellation");
  wrapper.appendChild(thinking);
  window.chatMessages.appendChild(wrapper);
  setupZodiacLoader(loader);

  if (window.scrollMessageToBottom) {
    window.scrollMessageToBottom();
  } else if (window.scrollMessageToTop) {
    window.scrollMessageToTop(wrapper);
  }

  return wrapper;
}

document.querySelectorAll<HTMLElement>(".constellation-loader").forEach((loader) => {
  setupZodiacLoader(loader);
});

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

async function consumeStreamingChatResponse(response: Response, thinkingWrap: HTMLElement | null) {
  if (!response.body) {
    throw new Error("ストリーム応答を受信できませんでした。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let streamError: string | null = null;
  let streamHandle: StreamingBotMessageHandle | null = null;

  const dismissThinkingState = () => {
    window.hideTypingIndicator?.();
    thinkingWrap?.remove();
    thinkingWrap = null;
  };

  const ensureStreamHandle = () => {
    if (streamHandle) return streamHandle;
    dismissThinkingState();
    streamHandle = window.startStreamingBotMessage?.() || null;
    if (!streamHandle) {
      throw new Error("ストリーム描画を開始できませんでした。");
    }
    return streamHandle;
  };

  const renderStreamError = (message: string) => {
    dismissThinkingState();
    const activeStreamHandle = streamHandle as StreamingBotMessageHandle | null;
    if (activeStreamHandle !== null) {
      activeStreamHandle.showError(message);
      return;
    }
    window.renderBotMessageImmediate?.("エラー: " + message);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    blocks.forEach((block) => {
      const parsed = parseStreamEventBlock(block);
      if (!parsed) return;

      if (parsed.event === "chunk") {
        const text = typeof parsed.data.text === "string" ? parsed.data.text : "";
        if (!text) return;
        ensureStreamHandle().appendChunk(text);
        return;
      }

      if (parsed.event === "done") {
        completed = true;
        const responseText = typeof parsed.data.response === "string" ? parsed.data.response : "";
        if (streamHandle) {
          streamHandle.complete();
        } else {
          dismissThinkingState();
          if (responseText) {
            window.renderBotMessageImmediate?.(responseText);
          }
        }
        return;
      }

      if (parsed.event === "error") {
        streamError = typeof parsed.data.message === "string"
          ? parsed.data.message
          : "ストリーム生成中にエラーが発生しました。";
      }
    });

    if (streamError) {
      renderStreamError(streamError);
      break;
    }

    if (done) break;
  }

  if (!completed && !streamError) {
    renderStreamError("ストリームが途中で終了しました。");
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

  // Bot 側の Thinking プレースホルダー
  const thinkingWrap = createThinkingPlaceholder();

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
      await consumeStreamingChatResponse(response, thinkingWrap);
      return;
    }

    const data = await response.json();
    window.hideTypingIndicator?.();
    thinkingWrap?.remove();
    if (data && data.response) {
      window.renderBotMessageImmediate?.(data.response);
    } else if (data && data.error) {
      window.renderBotMessageImmediate?.("エラー: " + data.error);
    } else {
      window.renderBotMessageImmediate?.("エラー: 予期しないエラーが発生しました。");
    }
  } catch (err) {
    window.hideTypingIndicator?.();
    thinkingWrap?.remove();
    const errorMessage = err instanceof Error ? err.message : String(err);
    window.renderBotMessageImmediate?.("エラー: " + errorMessage);
  }
}

// ---- window へ公開 ------------------------------
window.sendMessage = sendMessage;
window.generateResponse = generateResponse;

export {};
