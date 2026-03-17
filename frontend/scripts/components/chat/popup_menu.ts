// components/chat/popup_menu.ts (chat-specific)
const chatTemplate = document.createElement("template");
chatTemplate.innerHTML = `
  <style>
    :host {
      display: contents;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    input[type="checkbox"] {
      display: none;
    }

    .btn {
      border: none;
      border-radius: 50%;
      width: 50px;
      height: 50px;
      cursor: pointer;
      display: flex;
      justify-content: center;
      align-items: center;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
      box-shadow: 0 5px 20px rgba(0, 0, 0, 0.15);
      position: relative;
    }
    .btn:hover {
      transform: scale(1.1);
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.3);
    }
    .btn svg {
      width: 24px;
      height: 24px;
      fill: #fff;
      transition: transform 0.3s ease;
    }

    .actions-menu {
      position: fixed;
      bottom: 40px;
      right: 40px;
      width: 60px;
      height: 60px;
      animation: popIn 0.6s ease;
      z-index: 9999;
    }

    @keyframes popIn {
      0% {
        transform: scale(0.5) rotate(0deg);
        opacity: 0;
      }
      80% {
        transform: scale(1.05) rotate(360deg);
        opacity: 1;
      }
      100% {
        transform: scale(1) rotate(360deg);
        opacity: 1;
      }
    }

    .btn--menu {
      width: 60px;
      height: 60px;
      background: linear-gradient(135deg, #56ab2f, #a8e063);
      z-index: 1;
    }
    .btn--menu:after,
    .btn--menu:before,
    .btn--menu span {
      content: "";
      position: absolute;
      width: 25px;
      height: 3px;
      background: #fff;
      transition: transform 0.2s ease;
    }
    .btn--menu span {
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }
    .btn--menu:after {
      top: 50%;
      left: 50%;
      transform: translate(-50%, calc(-50% - 8px));
    }
    .btn--menu:before {
      top: 50%;
      left: 50%;
      transform: translate(-50%, calc(-50% + 8px));
    }

    .btn--share {
      background: linear-gradient(135deg, #3498db, #2980b9);
    }
    .btn--star {
      background: linear-gradient(135deg, #2ecc71, #27ae60);
    }
    .btn--comment {
      background: linear-gradient(135deg, #11998e, #38ef7d);
    }

    .actions-menu .btn {
      position: absolute;
      top: 8px;
      left: 8px;
      opacity: 0;
      transform: scale(0) rotate(0deg);
    }
    .actions-menu .btn--menu {
      position: absolute;
      top: 0;
      left: 0;
      width: 60px;
      height: 60px;
      opacity: 1;
      box-shadow: 0 5px 20px rgba(0, 0, 0, 0.2);
      transform: none;
    }

    #chatActionMenuButton:checked + .actions-menu > .btn {
      opacity: 1;
      transform: scale(1) rotate(360deg);
      transition: all 0.6s cubic-bezier(0.645, 0.045, 0.355, 1);
    }

    #chatActionMenuButton:checked + .actions-menu > .btn--share {
      top: -80px;
      left: 0px;
    }
    #chatActionMenuButton:checked + .actions-menu > .btn--star {
      top: -60px;
      left: -60px;
    }
    #chatActionMenuButton:checked + .actions-menu > .btn--comment {
      top: 0px;
      left: -80px;
    }

    #chatActionMenuButton:checked + .actions-menu .btn--menu:after {
      transform: translate(-50%, -50%) rotate(45deg);
    }
    #chatActionMenuButton:checked + .actions-menu .btn--menu:before {
      transform: translate(-50%, -50%) rotate(-45deg);
    }
    #chatActionMenuButton:checked + .actions-menu .btn--menu span {
      transform: translate(-50%, -50%) scale(0);
    }

    .btn--share:hover svg { transform: rotate(-20deg) scale(1.2); }
    .btn--star:hover svg  { transform: rotate(20deg)  scale(1.2); }
    .btn--comment:hover svg { transform: rotate(-20deg) scale(1.2); }

    @media (max-width: 768px) {
      .actions-menu {
        /* 固定inputの上に配置 (input ~56px + safe-area + 余白) */
        bottom: calc(70px + env(safe-area-inset-bottom, 0px));
        right: 12px;
        width: 48px;
        height: 48px;
      }
      .actions-menu .btn--menu {
        width: 48px !important;
        height: 48px !important;
      }
      .actions-menu .btn:not(.btn--menu) {
        width: 40px;
        height: 40px;
      }
      .btn svg {
        width: 20px;
        height: 20px;
      }
    }

    @media (max-width: 480px) {
      .actions-menu {
        bottom: calc(65px + env(safe-area-inset-bottom, 0px));
        right: 10px;
        width: 44px;
        height: 44px;
      }
      .actions-menu .btn--menu {
        width: 44px !important;
        height: 44px !important;
      }
      .actions-menu .btn:not(.btn--menu) {
        width: 36px;
        height: 36px;
      }
      .btn svg {
        width: 18px;
        height: 18px;
      }
    }
  </style>

  <input type="checkbox" id="chatActionMenuButton" />
  <div class="actions-menu">
    <button class="btn btn--share" onclick="location.href='/prompt_share'" title="シェア">
      <svg viewBox="0 0 24 24">
        <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7a3.048 3.048 0 0 0 0-1.39l7.13-4.17A3 3 0 1 0 14 5a3 3 0 0 0 .05.52l-7.14 4.18a3 3 0 1 0 0 4.6l7.14 4.18c-.03.17-.05.34-.05.52a3 3 0 1 0 3-2.92Z" />
      </svg>
    </button>
    <button class="btn btn--star" onclick="location.href='/'" title="スター">
      <svg viewBox="0 0 24 24">
        <path d="M12,17.27L18.18,21L16.54,13.97 L22,9.24L14.81,8.62L12,2 L9.19,8.62L2,9.24L7.45,13.97 L5.82,21L12,17.27Z" />
      </svg>
    </button>
    <button class="btn btn--comment" onclick="location.href='/memo'" title="メモ">
      <svg viewBox="0 0 24 24">
        <path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Zm-5 14v-5h5l-5 5Z" />
      </svg>
    </button>
    <label for="chatActionMenuButton" class="btn btn--menu"><span></span></label>
  </div>
`;

class ChatActionMenu extends HTMLElement {
  private toggle: HTMLInputElement | null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    shadow.appendChild(chatTemplate.content.cloneNode(true));

    this.toggle = shadow.querySelector("#chatActionMenuButton") as HTMLInputElement | null;
    document.addEventListener("click", (event) => {
      if (this.toggle?.checked && !event.composedPath().includes(this)) {
        this.toggle.checked = false;
      }
    });
  }
}

if (!customElements.get("chat-action-menu")) {
  customElements.define("chat-action-menu", ChatActionMenu);
}

export {};
