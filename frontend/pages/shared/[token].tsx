import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";

type SharedMessage = {
  message: string;
  sender: "user" | "assistant" | string;
  timestamp?: string;
};

type SharedRoom = {
  id: string;
  title?: string;
  created_at?: string;
};

type SharedChatPayload = {
  room?: SharedRoom;
  messages?: SharedMessage[];
  error?: string;
};

function decodeStoredMessage(raw: string) {
  return raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export default function SharedChatPage() {
  const router = useRouter();
  const token = useMemo(() => {
    const raw = router.query.token;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw) && raw.length > 0) return raw[0];
    return "";
  }, [router.query.token]);

  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<SharedChatPayload>({});

  useEffect(() => {
    if (!router.isReady || !token) return;

    setLoading(true);
    fetch(`/api/shared_chat_room?token=${encodeURIComponent(token)}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as SharedChatPayload;
        if (!response.ok) {
          setPayload({ error: data.error || `共有チャットの取得に失敗しました (${response.status})` });
          return;
        }
        setPayload(data);
      })
      .catch((error) => {
        setPayload({ error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        setLoading(false);
      });
  }, [router.isReady, token]);

  const title = payload.room?.title || "共有チャット";
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  return (
    <>
      <Head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <title>{title} | Chat Core 共有</title>
        <link rel="stylesheet" href="/static/css/pages/chat/shared_chat.css" />
      </Head>

      <div className="shared-chat-page">
        {loading && (
          <div className="shared-chat-error">共有チャットを読み込んでいます...</div>
        )}

        {!loading && payload.error && (
          <div className="shared-chat-error">{payload.error}</div>
        )}

        {!loading && !payload.error && (
          <div className="shared-chat-shell">
            <header className="shared-chat-header">
              <h1 className="shared-chat-header__title">{title}</h1>
              {payload.room?.created_at && (
                <p className="shared-chat-header__meta">作成日: {payload.room.created_at}</p>
              )}
            </header>

            <main className="shared-chat-messages">
              {messages.length === 0 && (
                <p className="shared-chat-empty">この共有チャットにはまだメッセージがありません。</p>
              )}

              {messages.map((message, index) => {
                const normalizedSender = message.sender === "user" ? "user" : "assistant";
                return (
                  <article
                    key={`${normalizedSender}-${index}-${message.timestamp || ""}`}
                    className={`shared-chat-message shared-chat-message--${normalizedSender}`}
                  >
                    {decodeStoredMessage(message.message || "")}
                  </article>
                );
              })}
            </main>

            <footer className="shared-chat-footer">
              このページは読み取り専用です。送信や編集はできません。
            </footer>
          </div>
        )}
      </div>
    </>
  );
}
