// chat_ui.ts  – チャット画面 UI 共通ユーティリティ
// --------------------------------------------------

let markedParser: any = null;
let markedLoadPromise: Promise<void> | null = null;
let hljs: any = null;
let markdownEnhancementDisabled = false;
const dynamicImport = new Function("modulePath", "return import(modulePath);") as (modulePath: string) => Promise<any>;

async function importOptionalModule(modulePath: string) {
  try {
    return await dynamicImport(modulePath);
  } catch (error) {
    console.warn(`Optional module '${modulePath}' could not be loaded.`, error);
    return null;
  }
}

async function importFirstAvailableModule(modulePaths: string[]) {
  for (const modulePath of modulePaths) {
    const loaded = await importOptionalModule(modulePath);
    if (loaded) return loaded;
  }
  return null;
}

function stripInvisibleCharacters(value: string) {
  return value.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isStandaloneLabelLine(line: string) {
  return /^([^:：]{1,24})[：:]$/u.test(line.trim());
}

function toStandaloneLabel(line: string) {
  const match = line.trim().match(/^([^:：]{1,24})[：:]$/u);
  if (!match) return line;
  return `**${match[1].trim()}:**`;
}

function isStandaloneTitleLine(lines: string[], index: number) {
  const trimmed = lines[index].trim();
  if (!trimmed || trimmed.length < 4 || trimmed.length > 44) return false;
  if (/^(#{1,6}\s|[-*>\d`])/.test(trimmed)) return false;
  if (/[。.!?！？]$/.test(trimmed)) return false;

  const prev = index > 0 ? lines[index - 1].trim() : "";
  const next = index < lines.length - 1 ? lines[index + 1].trim() : "";
  if (prev !== "" || next !== "") return false;

  return /[一-龯ぁ-んァ-ヶA-Za-z0-9]/.test(trimmed);
}

function isLikelyKeyValueLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[-*>\d]/.test(trimmed)) return false;
  return /^([^:：]{1,24})[：:]\s+.+$/u.test(trimmed);
}

function toKeyValueBullet(line: string) {
  const trimmed = line.trim();
  const match = trimmed.match(/^([^:：]{1,24})[：:]\s+(.+)$/u);
  if (!match) return trimmed;
  const key = match[1].trim();
  const value = match[2].trim();
  return `- **${key}:** ${value}`;
}

function collapseConsecutiveBlankLines(lines: string[], maxBlankLines = 1) {
  const output: string[] = [];
  let blankCount = 0;

  lines.forEach((line) => {
    if (line.trim().length === 0) {
      blankCount += 1;
      if (blankCount <= maxBlankLines) output.push("");
      return;
    }
    blankCount = 0;
    output.push(line);
  });

  return output;
}

function normalizeMarkdownSegmentForDisplay(segment: string) {
  const normalizedLines = segment
    .replace(/\u00a0/g, " ")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t \u3000]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\u3000]+$/g, ""));

  const promotedLines = [...normalizedLines];

  for (let i = 0; i < promotedLines.length; i += 1) {
    const trimmed = promotedLines[i].trim();
    if (/^「[^」]{4,80}」$/.test(trimmed)) {
      promotedLines[i] = `### ${trimmed}`;
      continue;
    }
    if (isStandaloneTitleLine(promotedLines, i)) {
      promotedLines[i] = `## ${trimmed}`;
    }
  }

  const listifiedLines: string[] = [];
  for (let i = 0; i < promotedLines.length; ) {
    if (!isLikelyKeyValueLine(promotedLines[i])) {
      listifiedLines.push(promotedLines[i]);
      i += 1;
      continue;
    }

    let j = i;
    while (j < promotedLines.length && isLikelyKeyValueLine(promotedLines[j])) {
      j += 1;
    }

    if (j - i >= 2) {
      for (let k = i; k < j; k += 1) {
        listifiedLines.push(toKeyValueBullet(promotedLines[k]));
      }
    } else {
      listifiedLines.push(promotedLines[i]);
    }
    i = j;
  }

  const labeledLines = listifiedLines.map((line) => (isStandaloneLabelLine(line) ? toStandaloneLabel(line) : line));
  const compacted = collapseConsecutiveBlankLines(labeledLines, 1);
  return stripInvisibleCharacters(compacted.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n").trimEnd());
}

function normalizeLLMTextForDisplay(rawText: string) {
  const normalized = rawText.replace(/\r\n?/g, "\n");
  const codeFencePattern = /(```[\s\S]*?```)/g;
  const parts = normalized.split(codeFencePattern);
  const formattedParts = parts
    .map((part, idx) => {
      if (!part) return "";
      // split() with capturing group: odd index is code fence
      if (idx % 2 === 1) return part.trim();
      return normalizeMarkdownSegmentForDisplay(part);
    })
    .filter((part) => part.length > 0);

  return formattedParts.join("\n\n").trim();
}

function formatMarkdownFallback(markdown: string) {
  const applyInlineMarkdownLite = (text: string) => {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    return html;
  };

  const codeBlocks: string[] = [];
  let codeIndex = 0;
  const tokenized = markdown.replace(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (_, codeContent: string) => {
    const token = `@@CODE_BLOCK_${codeIndex}@@`;
    codeBlocks.push(`<pre><code>${escapeHtml((codeContent || "").trimEnd())}</code></pre>`);
    codeIndex += 1;
    return token;
  });

  const lines = tokenized.split("\n");
  const htmlParts: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let paragraphOpen = false;

  const closeList = () => {
    if (!listType) return;
    htmlParts.push(`</${listType}>`);
    listType = null;
  };

  const closeParagraph = () => {
    if (!paragraphOpen) return;
    htmlParts.push("</p>");
    paragraphOpen = false;
  };

  lines.forEach((line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      closeParagraph();
      return;
    }

    if (/^@@CODE_BLOCK_\d+@@$/.test(trimmed)) {
      closeList();
      closeParagraph();
      htmlParts.push(trimmed);
      return;
    }

    const h3 = trimmed.match(/^###\s+(.+)$/);
    if (h3) {
      closeList();
      closeParagraph();
      htmlParts.push(`<h3>${escapeHtml(h3[1])}</h3>`);
      return;
    }

    const h2 = trimmed.match(/^##\s+(.+)$/);
    if (h2) {
      closeList();
      closeParagraph();
      htmlParts.push(`<h2>${escapeHtml(h2[1])}</h2>`);
      return;
    }

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1) {
      closeList();
      closeParagraph();
      htmlParts.push(`<h1>${escapeHtml(h1[1])}</h1>`);
      return;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      closeParagraph();
      const desiredType: "ul" | "ol" = unordered ? "ul" : "ol";
      if (listType !== desiredType) {
        closeList();
        htmlParts.push(`<${desiredType}>`);
        listType = desiredType;
      }
      htmlParts.push(`<li>${applyInlineMarkdownLite((unordered || ordered)?.[1] || "")}</li>`);
      return;
    }

    closeList();
    if (!paragraphOpen) {
      htmlParts.push("<p>");
      paragraphOpen = true;
    } else {
      htmlParts.push("<br>");
    }
    htmlParts.push(applyInlineMarkdownLite(trimmed));
  });

  closeList();
  closeParagraph();

  let html = htmlParts.join("");
  codeBlocks.forEach((block, idx) => {
    html = html.replace(`@@CODE_BLOCK_${idx}@@`, block);
  });
  return html;
}

function ensureMarkedParser() {
  if (markedParser) return Promise.resolve();
  if (markdownEnhancementDisabled) return Promise.resolve();
  if (markedLoadPromise) return markedLoadPromise;

  markedLoadPromise = (async () => {
    try {
      // 依存解決に失敗しても UI を壊さないよう、CDN モジュールを優先してベストエフォートで読み込む
      const markedModule = await importFirstAvailableModule([
        "https://esm.sh/marked@15.0.12?bundle"
      ]);
      const hljsModule = await importFirstAvailableModule([
        "https://esm.sh/highlight.js@11.11.1?bundle"
      ]);
      if (!markedModule) {
        markdownEnhancementDisabled = true;
        console.warn("Marked runtime module is unavailable. Falling back to lightweight markdown formatter.");
        return;
      }

      const { Marked } = markedModule;
      hljs = hljsModule?.default || hljsModule || null;
      
      const renderer = {
        code(token: any) {
          const text = token.text || "";
          const lang = token.lang || "plaintext";
          const language = lang.split(" ")[0] || "plaintext";
          
          let highlighted = text;
          try {
            if (hljs?.getLanguage?.(language)) {
              highlighted = hljs.highlight(text, { language }).value;
            } else if (hljs?.highlightAuto) {
              highlighted = hljs.highlightAuto(text).value;
            } else {
              highlighted = escapeHtml(text);
            }
          } catch (e) {
            console.error("Highlight error:", e);
            highlighted = escapeHtml(text);
          }

          return `
            <div class="code-block-container">
              <div class="code-block-header">
                <span class="code-block-lang">${language}</span>
                <button class="code-block-copy-btn" onclick="
                  const codeElement = this.closest('.code-block-container')?.querySelector('code');
                  const code = codeElement ? codeElement.innerText : '';
                  const icon = this.querySelector('i');
                  const textSpan = this.querySelector('span');
                  const defaultLabel = textSpan ? (textSpan.dataset.defaultLabel || textSpan.innerText) : '';
                  if (textSpan) textSpan.dataset.defaultLabel = defaultLabel;
                  const copyPromise = window.copyTextToClipboard
                    ? window.copyTextToClipboard(code)
                    : (navigator.clipboard && navigator.clipboard.writeText
                      ? navigator.clipboard.writeText(code)
                      : Promise.reject(new Error('Clipboard API unavailable')));
                  copyPromise.then(() => {
                    if (icon) {
                      icon.classList.remove('bi-clipboard', 'bi-x-lg');
                      icon.classList.add('bi-check-lg');
                      setTimeout(() => {
                        icon.classList.remove('bi-check-lg', 'bi-x-lg');
                        icon.classList.add('bi-clipboard');
                      }, 2000);
                    }
                    if (textSpan) {
                      textSpan.innerText = 'Copied!';
                      setTimeout(() => textSpan.innerText = defaultLabel, 2000);
                    }
                  }).catch((error) => {
                    console.error('Failed to copy code block.', error);
                    if (icon) {
                      icon.classList.remove('bi-clipboard', 'bi-check-lg');
                      icon.classList.add('bi-x-lg');
                      setTimeout(() => {
                        icon.classList.remove('bi-check-lg', 'bi-x-lg');
                        icon.classList.add('bi-clipboard');
                      }, 2000);
                    }
                    if (textSpan) {
                      textSpan.innerText = 'Failed';
                      setTimeout(() => textSpan.innerText = defaultLabel, 2000);
                    }
                  });
                ">
                  <i class="bi bi-clipboard"></i>
                  <span>Copy code</span>
                </button>
              </div>
              <pre><code class="hljs language-${language}">${highlighted}</code></pre>
            </div>`;
        }
      };

      const marked = new Marked();
      marked.use({ renderer });
      markedParser = marked.parse.bind(marked);
    } catch (error) {
      markdownEnhancementDisabled = true;
      console.warn("Failed to initialize markdown enhancement. Falling back to lightweight formatter.", error);
    } finally {
      markedLoadPromise = null;
    }
  })();

  return markedLoadPromise;
}

// グローバル初期化
window.currentChatRoomId = window.currentChatRoomId || null;

/* チャット画面を表示（セットアップ画面を隠す） */
function showChatInterface() {
  if (!window.setupContainer || !window.chatContainer) return;
  window.setupContainer.style.display = "none";
  window.chatContainer.style.display = "flex";
  window.refreshChatShareState?.();

  // Markdown パーサはチャット画面表示時に遅延読み込みする
  if (!markdownEnhancementDisabled) void ensureMarkedParser();

  if (!window.currentChatRoomId && localStorage.getItem("currentChatRoomId")) {
    window.currentChatRoomId = localStorage.getItem("currentChatRoomId");
  }
}

/* タイピングインジケータ */
function showTypingIndicator() {
  window.chatMessages?.setAttribute("aria-busy", "true");
}
function hideTypingIndicator() {
  window.chatMessages?.removeAttribute("aria-busy");
}

/* LLM 出力の Markdown を HTML に変換 */
function formatLLMOutput(text: string) {
  const normalized = normalizeLLMTextForDisplay(text);
  if (!markedParser) {
    if (!markdownEnhancementDisabled) void ensureMarkedParser();
    return formatMarkdownFallback(normalized);
  }

  const parsed = markedParser(normalized, {
    async: false,
    gfm: true,
    breaks: true
  });
  return typeof parsed === "string" ? parsed : normalized;
}

/*  サイドバートグル処理  */
function isOverlaySidebarViewport() {
  return window.matchMedia("(max-width: 960px)").matches;
}

function setSidebarOpen(isOpen: boolean) {
  const sb = document.querySelector(".sidebar");
  const toggleButton = document.getElementById("sidebar-toggle");
  if (!sb) return;

  const shouldOpen = isOverlaySidebarViewport() ? isOpen : false;
  sb.classList.toggle("open", shouldOpen);
  document.body.classList.toggle("sidebar-visible", shouldOpen);
  toggleButton?.setAttribute("aria-expanded", String(shouldOpen));
}

function toggleSidebar() {
  const sb = document.querySelector(".sidebar");
  if (!sb) return;
  setSidebarOpen(!sb.classList.contains("open"));
}

function closeSidebar() {
  setSidebarOpen(false);
}

const initSidebarToggle = () => {
  const sbBtn = document.getElementById("sidebar-toggle");
  sbBtn?.setAttribute("aria-expanded", "false");

  if (sbBtn)
    sbBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleSidebar();
    });
  // オーバーレイ／リンクタップで閉じる
  document.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (
      document.body.classList.contains("sidebar-visible") &&
      target &&
      !target.closest(".sidebar") &&
      !target.closest("#sidebar-toggle")
    ) {
      closeSidebar();
    }
  });

  window.addEventListener("resize", closeSidebar);
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initSidebarToggle);
} else {
  initSidebarToggle();
}

// ---- window へ公開 -------------------------------
window.showChatInterface = showChatInterface;
window.showTypingIndicator = showTypingIndicator;
window.hideTypingIndicator = hideTypingIndicator;
window.formatLLMOutput = formatLLMOutput;
window.closeChatSidebar = closeSidebar;

export {};
