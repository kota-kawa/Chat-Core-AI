const ALERT_MODAL_ROOT_ID = "cc-alert-modal-root";
const ALERT_MODAL_OPEN_CLASS = "cc-alert-modal-open";

class GlobalAlertModal {
  private readonly rootEl: HTMLDivElement;
  private readonly messageEl: HTMLParagraphElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly okBtn: HTMLButtonElement;
  private readonly queue: string[] = [];
  private isVisible = false;
  private previouslyFocusedElement: HTMLElement | null = null;

  constructor() {
    this.rootEl = this.createModalElement();

    const messageEl = this.rootEl.querySelector(".cc-alert-modal__message");
    const closeBtn = this.rootEl.querySelector(".cc-alert-modal__close");
    const okBtn = this.rootEl.querySelector(".cc-alert-modal__button");

    if (
      !(messageEl instanceof HTMLParagraphElement) ||
      !(closeBtn instanceof HTMLButtonElement) ||
      !(okBtn instanceof HTMLButtonElement)
    ) {
      throw new Error("Alert modal elements are missing.");
    }

    this.messageEl = messageEl;
    this.closeBtn = closeBtn;
    this.okBtn = okBtn;
    this.bindEvents();
  }

  public readonly alert = (message?: unknown) => {
    this.queue.push(this.normalizeMessage(message));
    this.openNext();
  };

  private normalizeMessage(message?: unknown) {
    if (message === undefined) return "";
    return String(message);
  }

  private createModalElement() {
    const existing = document.getElementById(ALERT_MODAL_ROOT_ID);
    if (existing instanceof HTMLDivElement) {
      return existing;
    }

    const root = document.createElement("div");
    root.id = ALERT_MODAL_ROOT_ID;
    root.className = "cc-alert-modal";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-hidden", "true");
    root.hidden = true;
    root.innerHTML = `
      <div class="cc-alert-modal__overlay" data-cc-alert-close></div>
      <div class="cc-alert-modal__dialog" role="document" tabindex="-1">
        <button type="button" class="cc-alert-modal__close" aria-label="閉じる">×</button>
        <h2 class="cc-alert-modal__title">お知らせ</h2>
        <p class="cc-alert-modal__message"></p>
        <div class="cc-alert-modal__actions">
          <button type="button" class="cc-alert-modal__button">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    return root;
  }

  private bindEvents() {
    this.rootEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.hasAttribute("data-cc-alert-close")) {
        this.closeCurrent();
      }
    });
    this.closeBtn.addEventListener("click", () => this.closeCurrent());
    this.okBtn.addEventListener("click", () => this.closeCurrent());
    document.addEventListener("keydown", this.handleKeyDown, true);
  }

  private readonly handleKeyDown = (event: KeyboardEvent) => {
    if (!this.isVisible) return;

    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      this.closeCurrent();
      return;
    }

    if (event.key !== "Tab") return;

    const focusable = this.getFocusableElements();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  private getFocusableElements() {
    const candidates = this.rootEl.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    return Array.from(candidates).filter((el) => !el.hasAttribute("disabled"));
  }

  private openNext() {
    if (this.isVisible) return;
    const nextMessage = this.queue.shift();
    if (nextMessage === undefined) return;

    this.previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.messageEl.textContent = nextMessage;
    this.rootEl.hidden = false;
    this.rootEl.setAttribute("aria-hidden", "false");
    this.rootEl.classList.add("is-visible");
    document.body.classList.add(ALERT_MODAL_OPEN_CLASS);
    this.isVisible = true;
    this.okBtn.focus();
  }

  private closeCurrent() {
    if (!this.isVisible) return;

    this.rootEl.classList.remove("is-visible");
    this.rootEl.setAttribute("aria-hidden", "true");
    this.rootEl.hidden = true;
    this.isVisible = false;
    document.body.classList.remove(ALERT_MODAL_OPEN_CLASS);

    if (this.previouslyFocusedElement?.isConnected) {
      this.previouslyFocusedElement.focus();
    }
    this.previouslyFocusedElement = null;

    this.openNext();
  }
}

function ensureGlobalAlertModal() {
  if (typeof window === "undefined") return;
  if (typeof document === "undefined") return;

  type AlertModalWindow = typeof window & {
    __chatcoreAlertModalInitialized?: boolean;
  };

  const globalWindow = window as AlertModalWindow;
  if (globalWindow.__chatcoreAlertModalInitialized) return;

  const install = () => {
    if (globalWindow.__chatcoreAlertModalInitialized) return;
    const alertModal = new GlobalAlertModal();
    window.alert = alertModal.alert;
    globalWindow.__chatcoreAlertModalInitialized = true;
  };

  if (!document.body) {
    document.addEventListener("DOMContentLoaded", install, { once: true });
    return;
  }

  install();
}

ensureGlobalAlertModal();

export {};
