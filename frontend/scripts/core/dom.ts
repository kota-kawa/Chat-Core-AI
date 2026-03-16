// dom.ts
// 画面内で使用するDOM要素をまとめて取得し、グローバル変数として window に登録

// セットアップ画面関連
const setupContainer = document.getElementById("setup-container");
const setupInfoElement = document.getElementById("setup-info") as HTMLTextAreaElement | null;
const aiModelSelect = document.getElementById("ai-model") as HTMLSelectElement | null;
const accessChatBtn = document.getElementById("access-chat-btn");
const setupTaskCards = document.querySelectorAll(".task-selection .prompt-card");
const taskSelection = document.querySelector(".task-selection");

// チャット画面関連
const chatContainer = document.getElementById("chat-container");
const chatMessages = document.getElementById("chat-messages");
const userInput = document.getElementById("user-input") as HTMLInputElement | null;
const sendBtn = document.getElementById("send-btn");
const backToSetupBtn = document.getElementById("back-to-setup");
const newChatBtn = document.getElementById("new-chat-btn");
const chatRoomListEl = document.getElementById("chat-room-list");

// グローバル登録
window.setupContainer = setupContainer;
window.chatContainer = chatContainer;
window.chatMessages = chatMessages;
window.userInput = userInput;
window.sendBtn = sendBtn;
window.backToSetupBtn = backToSetupBtn;
window.newChatBtn = newChatBtn;
window.chatRoomListEl = chatRoomListEl;
window.setupInfoElement = setupInfoElement;
window.aiModelSelect = aiModelSelect;
window.accessChatBtn = accessChatBtn;
window.setupTaskCards = setupTaskCards;
window.taskSelection = taskSelection;

export {};
