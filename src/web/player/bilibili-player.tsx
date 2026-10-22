import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../ui/feedback.tsx";
import { bilibiliEmbedUrl, CAPABILITIES, type PlayerSource } from "./capabilities.ts";
import { usePlayerController } from "./player-controller.tsx";

/**
 * Bilibili's embedded player only takes URL parameters: seeking reloads the
 * iframe with `t=` and autoplay, showing a loading state; it cannot report its time.
 */
export function BilibiliPlayer(props: { source: Extract<PlayerSource, { kind: "bilibili" }> }) {
  const { t } = useTranslation();
  const controller = usePlayerController();
  const [src, setSrc] = useState(() => bilibiliEmbedUrl(props.source, undefined));
  const [loading, setLoading] = useState(true);
  const { source } = props;

  useEffect(
    () =>
      controller.attach({
        capabilities: CAPABILITIES.bilibili,
        seek: (ms) => {
          setLoading(true);
          setSrc(bilibiliEmbedUrl(source, ms));
        },
      }),
    [controller, source],
  );

  return (
    <div className="relative">
      <iframe
        data-testid="player-bilibili"
        title="Bilibili"
        src={src}
        className="aspect-video w-full rounded-md border-0 bg-black"
        allow="autoplay; fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        onLoad={() => setLoading(false)}
      />
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-md bg-black/40 text-sm text-white" data-testid="player-loading">
          <Spinner />
          {t("contentView.player.loading")}
        </div>
      ) : null}
    </div>
  );
}
