import type { DetailedHTMLProps, HTMLAttributes } from "react";

type HtmlTagProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement>;

interface StreamingBotMessageHandle {
  appendChunk: (chunk: string) => void;
  complete: () => void;
  showError: (message: string) => void;
}

declare global {
  interface Window {
    loggedIn?: boolean;
    currentChatRoomId?: string | null;
    isEditingOrder?: boolean;
    currentEditingCard?: HTMLElement | null;
    setupContainer?: HTMLElement | null;
    chatContainer?: HTMLElement | null;
    chatMessages?: HTMLElement | null;
    userInput?: HTMLInputElement | null;
    sendBtn?: HTMLElement | null;
    typingIndicator?: HTMLElement | null;
    backToSetupBtn?: HTMLElement | null;
    newChatBtn?: HTMLElement | null;
    chatRoomListEl?: HTMLElement | null;
    setupInfoElement?: HTMLTextAreaElement | null;
    aiModelSelect?: HTMLSelectElement | null;
    accessChatBtn?: HTMLElement | null;
    setupTaskCards?: NodeListOf<Element>;
    taskSelection?: Element | null;
    showSetupForm?: () => void;
    initToggleTasks?: () => void;
    initSetupTaskCards?: () => void;
    loadTaskCards?: (options?: { forceRefresh?: boolean }) => void;
    invalidateTasksCache?: () => void;
    initTaskOrderEditing?: () => void;
    showChatInterface?: () => void;
    showTypingIndicator?: () => void;
    hideTypingIndicator?: () => void;
    formatLLMOutput?: (text: string) => string;
    renderSanitizedHTML?: (element: HTMLElement, dirtyHtml: string, allowed?: string[]) => void;
    setTextWithLineBreaks?: (element: HTMLElement, text: string) => void;
    scrollMessageToTop?: (element: HTMLElement) => void;
    scrollMessageToBottom?: () => void;
    createCopyBtn?: (getText: () => string) => HTMLButtonElement;
    renderUserMessage?: (text: string) => void;
    renderBotMessageImmediate?: (text: string) => void;
    startStreamingBotMessage?: () => StreamingBotMessageHandle | null;
    displayMessage?: (text: string, sender: string) => void;
    loadChatHistory?: () => void;
    loadLocalChatHistory?: () => void;
    saveMessageToLocalStorage?: (text: string, sender: string) => void;
    loadChatRooms?: () => void;
    switchChatRoom?: (roomId: string) => void;
    createNewChatRoom?: (roomId: string, title: string) => Promise<unknown>;
    deleteChatRoom?: (roomId: string) => void;
    renameChatRoom?: (roomId: string, newTitle: string) => void;
    sendMessage?: () => void;
    generateResponse?: (message: string, aiModel: string) => void;
    toggleUserMenu?: () => void;
  }

  var currentChatRoomId: string | null;
  var setupContainer: HTMLElement | null;
  var chatContainer: HTMLElement | null;
  var chatMessages: HTMLElement | null;
  var userInput: HTMLInputElement | null;
  var sendBtn: HTMLElement | null;
  var typingIndicator: HTMLElement | null;
  var backToSetupBtn: HTMLElement | null;
  var newChatBtn: HTMLElement | null;
  var chatRoomListEl: HTMLElement | null;
  var setupInfoElement: HTMLTextAreaElement | null;
  var aiModelSelect: HTMLSelectElement | null;
  var accessChatBtn: HTMLElement | null;
  var setupTaskCards: NodeListOf<Element>;
  var taskSelection: Element | null;

  const DOMPurify: {
    sanitize: (
      dirty: string,
      config?: {
        ALLOWED_TAGS?: string[];
        ALLOWED_ATTR?: string[];
      }
    ) => string;
  };

  const bootstrap: {
    Modal: {
      new (element: Element): { show: () => void; hide: () => void };
      getInstance: (element: Element | null) => { show: () => void; hide: () => void } | null;
    };
  };

  namespace JSX {
    interface IntrinsicElements {
      "action-menu": HtmlTagProps;
      "chat-action-menu": HtmlTagProps;
      "user-icon": HtmlTagProps;
    }
  }
}

export {};
