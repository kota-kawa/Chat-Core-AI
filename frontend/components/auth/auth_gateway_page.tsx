import Head from "next/head";
import { Outfit } from "next/font/google";
import { useEffect, useRef, useState, type MutableRefObject } from "react";

import { ensureCsrfProtection } from "../../scripts/core/csrf";
import {
  authenticateWithPasskey,
  browserSupportsPasskeys,
  PasskeyCancelledError,
  registerPasskey
} from "../../scripts/core/passkeys";

type AuthStep = "entry" | "code" | "passkey";
type EmailAuthFlow = "login" | "register" | null;
type PasskeySetupProvider = "email" | "google" | null;

const REDIRECT_DELAY_MS = 1200;
const MODAL_AUTO_CLOSE_MS = 2200;
const MODAL_CLOSE_ANIMATION_MS = 500;

const authHeadingFont = Outfit({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap"
});

export default function AuthGatewayPage() {
  const [step, setStep] = useState<AuthStep>("entry");
  const [email, setEmail] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [modalMessage, setModalMessage] = useState<string | null>(null);
  const [isModalClosing, setIsModalClosing] = useState(false);
  const [supportsPasskeys, setSupportsPasskeys] = useState(false);
  const [emailAuthFlow, setEmailAuthFlow] = useState<EmailAuthFlow>(null);
  const [passkeySetupProvider, setPasskeySetupProvider] = useState<PasskeySetupProvider>(null);

  const modalAutoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modalCloseAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = (timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const hideModal = () => {
    setIsModalClosing(true);
    clearTimer(modalAutoCloseTimerRef);
    clearTimer(modalCloseAnimationTimerRef);

    modalCloseAnimationTimerRef.current = setTimeout(() => {
      setModalMessage(null);
      setIsModalClosing(false);
    }, MODAL_CLOSE_ANIMATION_MS);
  };

  const showModalMessage = (message: string) => {
    setModalMessage(message);
    setIsModalClosing(false);
    clearTimer(modalAutoCloseTimerRef);
    clearTimer(modalCloseAnimationTimerRef);

    modalAutoCloseTimerRef.current = setTimeout(() => {
      hideModal();
    }, MODAL_AUTO_CLOSE_MS);
  };

  const sanitizeNextPath = (rawNextPath: string | null): string => {
    if (!rawNextPath) return "/";
    if (!rawNextPath.startsWith("/")) return "/";

    try {
      const targetUrl = new URL(rawNextPath, window.location.origin);
      if (targetUrl.origin !== window.location.origin) {
        return "/";
      }
      return `${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}` || "/";
    } catch {
      return "/";
    }
  };

  const getSearchParams = (): URLSearchParams => {
    if (typeof window === "undefined") {
      return new URLSearchParams();
    }
    return new URLSearchParams(window.location.search);
  };

  const getPostAuthRedirectPath = (): string => sanitizeNextPath(getSearchParams().get("next"));

  const buildGoogleLoginUrl = (): string => {
    const nextPath = getPostAuthRedirectPath();
    if (nextPath === "/") {
      return "/google-login";
    }
    return `/google-login?${new URLSearchParams({ next: nextPath }).toString()}`;
  };

  const scheduleRedirect = (targetPath: string = getPostAuthRedirectPath()) => {
    clearTimer(redirectTimerRef);
    redirectTimerRef.current = setTimeout(() => {
      window.location.href = targetPath;
    }, REDIRECT_DELAY_MS);
  };

  useEffect(() => {
    ensureCsrfProtection();
    document.body.classList.add("auth-page");
    setSupportsPasskeys(browserSupportsPasskeys());
    return () => {
      document.body.classList.remove("auth-page");
      clearTimer(modalAutoCloseTimerRef);
      clearTimer(modalCloseAnimationTimerRef);
      clearTimer(redirectTimerRef);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const checkLoginState = async () => {
      const query = getSearchParams();
      const nextPath = getPostAuthRedirectPath();
      const supportsPasskeysNow = browserSupportsPasskeys();
      const shouldOfferPasskeySetup = supportsPasskeysNow && query.get("offer_passkey_setup") === "1";
      const queryFlow = query.get("flow") === "register" ? "register" : "login";
      const provider = query.get("provider") === "google" ? "google" : "email";

      try {
        const response = await fetch("/api/current_user", {
          credentials: "same-origin"
        });
        const data = await response.json();

        if (!cancelled && data.logged_in) {
          if (shouldOfferPasskeySetup) {
            setEmailAuthFlow(queryFlow);
            setPasskeySetupProvider(provider);
            setStep("passkey");
            showModalMessage(
              provider === "google"
                ? "Googleでログインしました。必要ならこのままPasskeyを追加できます。"
                : "アカウントを作成しました。必要ならこのままPasskeyを追加できます。"
            );
            return;
          }
          window.location.href = nextPath;
        }
      } catch (error) {
        console.error("Error checking login state:", error);
      }
    };

    const checkTimerId = window.setTimeout(() => {
      void checkLoginState();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(checkTimerId);
    };
  }, []);

  const handleSendCode = async () => {
    const trimmedEmail = email.trim();
    setErrorMessage("");
    setEmailAuthFlow(null);
    setPasskeySetupProvider(null);

    if (!trimmedEmail) {
      setErrorMessage("メールアドレスを入力してください。");
      return;
    }

    setSendingCode(true);
    try {
      const response = await fetch("/api/auth/send_email_code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail })
      });
      const data = await response.json().catch(() => ({}));

      if (data.status === "success") {
        setStep("code");
        showModalMessage("認証コードを送信しました。メールを確認してください。");
      } else {
        setErrorMessage(typeof data.error === "string" ? data.error : "認証コード送信に失敗しました。");
      }
    } catch (error) {
      console.error("Error sending email auth code:", error);
      setErrorMessage("サーバーエラーが発生しました。");
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerifyCode = async () => {
    const trimmedCode = authCode.trim();
    setErrorMessage("");

    if (!trimmedCode) {
      setErrorMessage("認証コードを入力してください。");
      return;
    }

    setVerifyingCode(true);
    try {
      const response = await fetch("/api/auth/verify_email_code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authCode: trimmedCode })
      });
      const data = await response.json().catch(() => ({}));

      if (data.status === "success") {
        const flow = data.flow === "register" ? "register" : "login";
        const shouldOfferPasskeySetup = flow === "register" && supportsPasskeys && data.offer_passkey_setup === true;
        setEmailAuthFlow(flow);
        setPasskeySetupProvider("email");

        if (shouldOfferPasskeySetup) {
          setStep("passkey");
          showModalMessage("アカウントを作成しました。必要ならこのままPasskeyを追加できます。");
        } else {
          if (flow === "register") {
            showModalMessage("アカウントを作成しました。");
          }
          scheduleRedirect();
        }
      } else {
        setErrorMessage(typeof data.error === "string" ? data.error : "認証に失敗しました。");
      }
    } catch (error) {
      console.error("Error verifying email auth code:", error);
      setErrorMessage("サーバーエラーが発生しました。");
    } finally {
      setVerifyingCode(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setErrorMessage("");
    setPasskeyPending(true);
    try {
      await authenticateWithPasskey();
      window.location.href = getPostAuthRedirectPath();
    } catch (error) {
      if (error instanceof PasskeyCancelledError) {
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : "Passkey認証に失敗しました。");
    } finally {
      setPasskeyPending(false);
    }
  };

  const handlePasskeyRegistration = async () => {
    setErrorMessage("");
    setPasskeyPending(true);
    try {
      await registerPasskey();
      showModalMessage("Passkeyを保存しました。");
      scheduleRedirect();
    } catch (error) {
      if (error instanceof PasskeyCancelledError) {
        return;
      }
      setErrorMessage(error instanceof Error ? error.message : "Passkey登録に失敗しました。");
    } finally {
      setPasskeyPending(false);
    }
  };

  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Chat Core 認証</title>
        <link rel="icon" type="image/webp" href="/static/favicon.webp" />
        <link rel="icon" type="image/png" href="/static/favicon.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png" />
      </Head>

      <div className="auth-page-root">
        <div className="chat-background" />

        <div className="auth-container">
          {(sendingCode || verifyingCode || passkeyPending) ? (
            <div className="spinner-overlay" role="status" aria-live="polite" aria-label="処理中">
              <div className="spinner-ring" />
            </div>
          ) : null}

          <div className="bot-icon">{step === "passkey" ? "🔐" : supportsPasskeys ? "🌿" : "✉️"}</div>
          <h1 className="title">アカウントに続ける</h1>
          <p className="subtitle">
            Passkey、Google、メール認証に対応しています。
            <br />
            初めての場合はメール認証後にアカウントを作成します。
          </p>

          <div className="error-message" role="alert">{errorMessage}</div>

          {step === "entry" ? (
            <>
              {supportsPasskeys ? (
                <button
                  type="button"
                  className="passkey-btn"
                  onClick={() => void handlePasskeyLogin()}
                  disabled={passkeyPending}
                >
                  Passkeyで続ける
                </button>
              ) : null}

              <div className="google-container">
                <button
                  type="button"
                  className="google-btn"
                  id="googleAuthBtn"
                  onClick={() => {
                    window.location.href = buildGoogleLoginUrl();
                  }}
                >
                  <svg
                    className="google-icon"
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path
                      fill="#EA4335"
                      d="M12 10.2v3.9h5.5c-.2 1.2-.9 2.2-1.9 3v2.5h3.1c1.8-1.6 2.8-4.1 2.8-7 0-.7-.1-1.5-.2-2.2H12z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 22c2.7 0 5-0.9 6.6-2.4l-3.1-2.5c-.9.6-2 .9-3.4.9-2.6 0-4.8-1.7-5.6-4.1H3.3v2.6C4.9 19.8 8.2 22 12 22z"
                    />
                    <path
                      fill="#4A90E2"
                      d="M6.4 13.9c-.2-.6-.3-1.2-.3-1.9s.1-1.3.3-1.9V7.5H3.3C2.5 9 2 10.5 2 12s.5 3 1.3 4.5l3.1-2.6z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M12 6.1c1.5 0 2.8.5 3.9 1.5l2.9-2.9C17 2.9 14.7 2 12 2 8.2 2 4.9 4.2 3.3 7.5l3.1 2.6c.8-2.4 3-4 5.6-4z"
                    />
                  </svg>
                  <span>Googleで続ける</span>
                </button>
              </div>

              <div className="divider"><span>またはメール</span></div>

              <label htmlFor="email" className="email-label">メールアドレス</label>
              <input
                type="email"
                id="email"
                name="email"
                required
                className="email-input"
                placeholder="example@mail.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email webauthn"
              />
              <button
                type="button"
                className="submit-btn"
                onClick={() => void handleSendCode()}
                disabled={sendingCode}
              >
                メールで続ける
              </button>
            </>
          ) : null}

          {step === "code" ? (
            <>
              <div className="code-panel">
                <p className="step-caption">メールに届いた認証コードを入力してください。</p>
                <label htmlFor="authCode" className="email-label">認証コード</label>
                <input
                  type="text"
                  id="authCode"
                  name="authCode"
                  required
                  className="email-input"
                  placeholder="認証コードを入力"
                  value={authCode}
                  onChange={(event) => setAuthCode(event.target.value)}
                  autoComplete="one-time-code"
                />
                <button
                  type="button"
                  className="submit-btn"
                  onClick={() => void handleVerifyCode()}
                  disabled={verifyingCode}
                >
                  認証して続ける
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => {
                    setAuthCode("");
                    setErrorMessage("");
                    setStep("entry");
                  }}
                >
                  戻る
                </button>
              </div>
            </>
          ) : null}

          {step === "passkey" ? (
            <div className="passkey-panel">
              <p className="step-caption">
                {emailAuthFlow === "register"
                  ? (
                    passkeySetupProvider === "google"
                      ? "Googleログインは完了しています。必要ならこの端末にPasskeyを追加してください。"
                      : "アカウント作成は完了しています。必要ならこの端末にPasskeyを追加してください。"
                  )
                  : "この端末にPasskeyを保存すると、次回からメールコードなしで入れます。"}
              </p>
              <button
                type="button"
                className="passkey-btn"
                onClick={() => void handlePasskeyRegistration()}
                disabled={passkeyPending}
              >
                この端末にPasskeyを保存
              </button>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => scheduleRedirect()}
              >
                後で設定する
              </button>
            </div>
          ) : null}
        </div>

        <div
          id="messageModal"
          className={`modal ${modalMessage ? "is-open" : ""} ${isModalClosing ? "hide-animation" : ""}`}
          onClick={hideModal}
        >
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <button className="close" type="button" onClick={hideModal} aria-label="閉じる">
              &times;
            </button>
            <p id="modalMessage">{modalMessage}</p>
          </div>
        </div>
      </div>

      <style jsx global>{`
        :root {
          --accent: #00ff88;
          --accent-soft: #ccff99;
          --bg-1: #0e401e;
          --bg-2: #164f2f;
          --glass: rgba(12, 28, 20, 0.72);
          --glass-border: rgba(255, 255, 255, 0.12);
          --text: #eafff3;
          --muted: rgba(255, 255, 255, 0.72);
        }

        * {
          box-sizing: border-box;
        }

        body.auth-page,
        .auth-page-root {
          margin: 0;
          padding: 0;
          font-family: ${authHeadingFont.style.fontFamily}, var(--font-app-sans), "Segoe UI", sans-serif;
          background: linear-gradient(135deg, var(--bg-1), var(--bg-2));
          min-height: 100vh;
          min-height: 100dvh;
          width: 100%;
          display: flex;
          justify-content: center;
          align-items: center;
          color: var(--text);
          overflow: hidden;
          position: relative;
        }

        .auth-page-root {
          width: 100vw;
          min-height: 100vh;
          min-height: 100dvh;
          isolation: isolate;
        }

        .auth-container {
          position: relative;
          z-index: 1;
          background: var(--glass);
          border: 1px solid var(--glass-border);
          backdrop-filter: blur(12px);
          padding: 36px 32px 32px;
          border-radius: 24px;
          text-align: center;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08);
          width: min(92vw, 460px);
          margin: 0 auto;
          animation: cardIn 0.8s ease;
        }

        @media (max-width: 600px) {
          .auth-container {
            padding: 28px 22px 26px;
          }
        }

        @keyframes cardIn {
          from {
            opacity: 0;
            transform: translateY(18px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .bot-icon {
          font-size: 3rem;
          line-height: 1;
        }

        .title {
          font-size: 2.1rem;
          color: var(--accent);
          margin: 12px 0 10px;
          letter-spacing: 0.06em;
          text-shadow: 0 8px 24px rgba(0, 255, 136, 0.25);
        }

        .subtitle {
          margin: 0 0 20px;
          color: var(--muted);
          font-size: 0.95rem;
          line-height: 1.6;
        }

        .divider {
          display: flex;
          align-items: center;
          gap: 12px;
          margin: 18px 0 14px;
          color: var(--muted);
          font-size: 0.9rem;
        }

        .divider::before,
        .divider::after {
          content: "";
          flex: 1;
          height: 1px;
          background: rgba(255, 255, 255, 0.12);
        }

        .email-label {
          display: block;
          font-size: 0.95rem;
          color: var(--muted);
          margin: 12px 0 8px;
          text-align: left;
        }

        .email-input {
          width: 100%;
          padding: 12px 16px;
          font-size: 1rem;
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 16px;
          background: rgba(10, 20, 15, 0.55);
          color: #ffffff;
          outline: none;
          transition: border 0.25s ease, box-shadow 0.25s ease, background 0.25s ease;
          margin-bottom: 16px;
        }

        .email-input::placeholder {
          color: rgba(255, 255, 255, 0.5);
        }

        .email-input:focus {
          background: rgba(10, 20, 15, 0.7);
          border-color: var(--accent);
          box-shadow: 0 0 0 4px rgba(0, 255, 136, 0.12);
        }

        .submit-btn,
        .passkey-btn,
        .ghost-btn,
        .google-btn {
          width: 100%;
          border: none;
          border-radius: 16px;
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.25s ease, background 0.25s ease;
        }

        .submit-btn,
        .passkey-btn {
          padding: 13px 18px;
          font-size: 1rem;
          font-weight: 700;
          margin-top: 4px;
        }

        .passkey-btn {
          background: linear-gradient(135deg, #00ff88, #8cffc1);
          color: #072b1a;
          box-shadow: 0 12px 28px rgba(0, 255, 136, 0.25);
        }

        .submit-btn {
          background: #eafff3;
          color: #0a2a18;
        }

        .ghost-btn {
          margin-top: 12px;
          padding: 12px 16px;
          background: rgba(255, 255, 255, 0.06);
          color: var(--text);
          font-weight: 600;
        }

        .submit-btn:hover:not(:disabled),
        .passkey-btn:hover:not(:disabled),
        .ghost-btn:hover:not(:disabled),
        .google-btn:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        .submit-btn:disabled,
        .passkey-btn:disabled,
        .ghost-btn:disabled,
        .google-btn:disabled {
          cursor: wait;
          opacity: 0.65;
        }

        .google-container {
          margin-top: 8px;
        }

        .google-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          padding: 12px 16px;
          background: #ffffff;
          color: #163022;
          font-weight: 700;
        }

        .google-icon {
          flex: 0 0 auto;
        }

        .step-caption {
          margin: 0 0 6px;
          color: var(--muted);
          line-height: 1.6;
        }

        .code-panel,
        .passkey-panel {
          animation: sectionIn 0.2s ease;
        }

        @keyframes sectionIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .error-message {
          min-height: 24px;
          margin-bottom: 6px;
          color: #ffb3b3;
          font-size: 0.92rem;
        }

        .spinner-overlay {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          background: rgba(7, 20, 14, 0.45);
          border-radius: 24px;
          z-index: 3;
        }

        .spinner-ring {
          width: 48px;
          height: 48px;
          border-radius: 999px;
          border: 4px solid rgba(255, 255, 255, 0.18);
          border-top-color: var(--accent);
          animation: spin 0.85s linear infinite;
        }

        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }

        .modal {
          position: fixed;
          inset: 0;
          z-index: 40;
          display: none;
          align-items: center;
          justify-content: center;
          padding: 20px;
          background: rgba(0, 0, 0, 0.5);
        }

        .modal.is-open {
          display: flex;
        }

        .modal-content {
          position: relative;
          width: min(92vw, 360px);
          padding: 24px 22px 22px;
          border-radius: 22px;
          background: rgba(8, 20, 14, 0.95);
          border: 1px solid rgba(255, 255, 255, 0.1);
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.45);
          animation: modalIn 0.18s ease;
        }

        .modal.hide-animation .modal-content {
          animation: modalOut 0.18s ease forwards;
        }

        @keyframes modalIn {
          from {
            opacity: 0;
            transform: scale(0.96);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }

        @keyframes modalOut {
          to {
            opacity: 0;
            transform: scale(0.96);
          }
        }

        .close {
          position: absolute;
          top: 10px;
          right: 12px;
          border: none;
          background: transparent;
          color: #ffffff;
          font-size: 1.5rem;
          cursor: pointer;
        }

        #modalMessage {
          margin: 0;
          white-space: pre-wrap;
          line-height: 1.6;
        }
      `}</style>
    </>
  );
}
