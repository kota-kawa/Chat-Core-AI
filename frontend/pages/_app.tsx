import "../styles/globals.css";
import "../styles/chat-entry.css";
import "../styles/memo-entry.css";
import "../styles/prompt-share-entry.css";
import "../scripts/core/tooltip";
import "../scripts/core/alert_modal";
import type { AppProps } from "next/app";
import { Noto_Sans_JP } from "next/font/google";

const appSansFont = Noto_Sans_JP({
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap"
});

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <style jsx global>{`
        :root {
          --font-app-sans: ${appSansFont.style.fontFamily};
        }
      `}</style>
      <Component {...pageProps} />
    </>
  );
}
