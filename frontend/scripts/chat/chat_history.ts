// chat_history.ts – 履歴のロード／保存
// --------------------------------------------------

let chatGenerationPollTimer: number | null = null;

function stopChatGenerationPolling() {
  if (chatGenerationPollTimer === null) return;
  window.clearTimeout(chatGenerationPollTimer);
  chatGenerationPollTimer = null;
}

function pollChatGenerationStatus(roomId: string, refreshHistoryOnCompletion = false) {
  stopChatGenerationPolling();

  const poll = () => {
    if (window.currentChatRoomId !== roomId) {
      stopChatGenerationPolling();
      return;
    }

    fetch(`/api/chat_generation_status?room_id=${encodeURIComponent(roomId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (window.currentChatRoomId !== roomId) {
          stopChatGenerationPolling();
          return;
        }

        if (data.error) {
          console.error("chat_generation_status:", data.error);
          stopChatGenerationPolling();
          return;
        }

        if (data.is_generating) {
          chatGenerationPollTimer = window.setTimeout(
            () => pollChatGenerationStatus(roomId, refreshHistoryOnCompletion),
            1500
          );
          return;
        }

        stopChatGenerationPolling();
        if (refreshHistoryOnCompletion) {
          loadChatHistory(false);
        }
      })
      .catch((err) => {
        console.error("生成状態取得失敗:", err);
        chatGenerationPollTimer = window.setTimeout(
          () => pollChatGenerationStatus(roomId, refreshHistoryOnCompletion),
          2500
        );
      });
  };

  chatGenerationPollTimer = window.setTimeout(poll, 0);
}

/* サーバーから履歴取得 */
function loadChatHistory(shouldPollStatus = true) {
  if (!window.currentChatRoomId) {
    stopChatGenerationPolling();
    if (window.chatMessages) window.chatMessages.innerHTML = "";
    return;
  }
  const roomId = window.currentChatRoomId;
  fetch(`/api/get_chat_history?room_id=${encodeURIComponent(roomId)}`)
    .then((r) => r.json())
    .then(async (data) => {
      if (data.error) {
        console.error("get_chat_history:", data.error);
        return;
      }
      if (!window.chatMessages) return;

      const msgs: { message: string; sender: string }[] = Array.isArray(data.messages) ? data.messages : [];

      const scrollToBottom = () => {
        if (window.scrollMessageToBottom) {
          window.scrollMessageToBottom();
        } else if (window.chatMessages?.lastElementChild && window.scrollMessageToTop) {
          window.scrollMessageToTop(window.chatMessages.lastElementChild as HTMLElement);
        }
      };

      const renderMsgs = (list: { message: string; sender: string }[]) => {
        list.forEach((m) => {
          if (window.displayMessage) window.displayMessage(m.message, m.sender);
        });
      };

      const saveToLocalStorage = (list: { message: string; sender: string }[]) => {
        localStorage.setItem(
          `chatHistory_${roomId}`,
          JSON.stringify(list.map((m) => ({ text: m.message, sender: m.sender })))
        );
      };

      if (!shouldPollStatus) {
        window.chatMessages.innerHTML = "";
        saveToLocalStorage(msgs);
        renderMsgs(msgs);
        scrollToBottom();
        stopChatGenerationPolling();
        return;
      }

      // 生成ステータスを確認
      let isGenerating = false;
      let hasReplayableJob = false;
      try {
        const statusResp = await fetch(`/api/chat_generation_status?room_id=${encodeURIComponent(roomId)}`);
        const statusData = await statusResp.json();
        if (!statusData.error) {
          isGenerating = statusData.is_generating === true;
          hasReplayableJob = statusData.has_replayable_job === true;
        }
      } catch {
        // ステータス取得失敗時は通常描画にフォールバック
      }

      // ルーム切替が起きていたら中断
      if (window.currentChatRoomId !== roomId) return;

      window.chatMessages.innerHTML = "";
      stopChatGenerationPolling();

      if (isGenerating) {
        // 生成中: 最後のbotメッセージはまだDBにないので全メッセージをそのまま表示
        saveToLocalStorage(msgs);
        renderMsgs(msgs);
        scrollToBottom();
        window.connectToGenerationStream?.(roomId);
      } else if (hasReplayableJob) {
        // 生成完了直後: 最後のassistantメッセージを除いて表示し、ストリームで再生
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].sender === "assistant") {
            lastAssistantIdx = i;
            break;
          }
        }
        const msgsWithoutLast =
          lastAssistantIdx >= 0
            ? [...msgs.slice(0, lastAssistantIdx), ...msgs.slice(lastAssistantIdx + 1)]
            : msgs;
        saveToLocalStorage(msgsWithoutLast);
        renderMsgs(msgsWithoutLast);
        scrollToBottom();
        window.connectToGenerationStream?.(roomId);
      } else {
        // 通常: 全メッセージ表示
        saveToLocalStorage(msgs);
        renderMsgs(msgs);
        scrollToBottom();
      }
    })
    .catch((err) => console.error("履歴取得失敗:", err));
}

/* ローカルストレージから履歴読み込み */
function loadLocalChatHistory() {
  if (!window.currentChatRoomId || !window.chatMessages) return;
  const key = `chatHistory_${window.currentChatRoomId}`;
  let history: { text: string; sender: string }[] = [];
  try {
    const stored = localStorage.getItem(key);
    history = stored ? JSON.parse(stored) : [];
  } catch {
    history = [];
  }
  window.chatMessages.innerHTML = "";
  history.forEach((item) => {
    if (window.displayMessage) window.displayMessage(item.text, item.sender);
  });

  if (window.scrollMessageToBottom) {
    window.scrollMessageToBottom();
  } else if (window.chatMessages.lastElementChild && window.scrollMessageToTop) {
    window.scrollMessageToTop(window.chatMessages.lastElementChild as HTMLElement);
  }
}

/* メッセージ1件をローカル保存 */
function saveMessageToLocalStorage(text: string, sender: string) {
  if (!window.currentChatRoomId) return;
  const key = `chatHistory_${window.currentChatRoomId}`;
  let history: { text: string; sender: string }[] = [];
  try {
    const stored = localStorage.getItem(key);
    history = stored ? JSON.parse(stored) : [];
  } catch {
    history = [];
  }
  history.push({ text, sender });
  localStorage.setItem(key, JSON.stringify(history));
}

// ---- window へ公開 ------------------------------
window.loadChatHistory = loadChatHistory;
window.loadLocalChatHistory = loadLocalChatHistory;
window.saveMessageToLocalStorage = saveMessageToLocalStorage;

export {};
