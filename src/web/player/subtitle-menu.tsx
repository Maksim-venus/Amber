import { Captions } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useTranslation } from "react-i18next";
import { PLAYER_MENU_CONTENT_CLASS, PLAYER_MENU_ITEM_CLASS } from "./player-menus.tsx";
import type { SubtitleTrackModel } from "./subtitle-overlay.tsx";
import { SUBTITLE_DISPLAY_MODES, type SubtitleDisplayMode } from "./subtitle-prefs.ts";

/** Coloured in the accent while subtitles are on, like the chosen item of a player menu. */
const TRIGGER_CLASS = "player-button data-[state=open]:bg-white/15 data-[active=true]:text-accent";
const LABEL_CLASS = "px-4 pt-1.5 pb-1 text-xs text-white/60";
const SEPARATOR_CLASS = "my-1 h-px bg-white/15";
const NOTE_CLASS = "max-w-56 px-4 py-1 text-xs text-white/60";

/**
 * The 「字幕」 menu of the local player's control bar: display mode, original
 * revision, translation (or 「去翻译」 without one) and 「样式与位置…」, which enters the
 * editor. Non-modal and portalled into the player like the other control-bar menus.
 */
export function SubtitleMenu(props: { model: SubtitleTrackModel; container: HTMLElement | null; onOpenChange?: (open: boolean) => void }) {
  const { t } = useTranslation();
  const { model } = props;
  const noTranslation = model.translations.length === 0;
  const needsTranslation = (mode: SubtitleDisplayMode): boolean => mode === "translation" || mode === "bilingual";
  return (
    <DropdownMenu.Root modal={false} {...(props.onOpenChange === undefined ? {} : { onOpenChange: props.onOpenChange })}>
      <DropdownMenu.Trigger
        className={TRIGGER_CLASS}
        aria-label={t("contentView.player.subtitles.button")}
        title={t("contentView.player.subtitles.button")}
        data-active={model.mode !== "off"}
        data-testid="player-subtitles"
      >
        <Captions size={18} aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={props.container ?? undefined}>
        <DropdownMenu.Content side="top" align="end" sideOffset={6} className={`${PLAYER_MENU_CONTENT_CLASS} max-h-80 overflow-y-auto`} data-testid="player-subtitles-menu">
          <DropdownMenu.Label className={LABEL_CLASS}>{t("contentView.player.subtitles.display")}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={model.mode}
            onValueChange={(value) => {
              const next = SUBTITLE_DISPLAY_MODES.find((mode) => mode === value);
              if (next !== undefined) model.setMode(next);
            }}
          >
            {SUBTITLE_DISPLAY_MODES.map((mode) => (
              <DropdownMenu.RadioItem
                key={mode}
                value={mode}
                disabled={noTranslation && needsTranslation(mode)}
                className={PLAYER_MENU_ITEM_CLASS}
                data-testid={`player-subtitles-mode-${mode}`}
              >
                {t(`contentView.player.subtitles.mode.${mode}`)}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {model.originals.length === 0 ? null : (
            <>
              <DropdownMenu.Separator className={SEPARATOR_CLASS} />
              <DropdownMenu.Label className={LABEL_CLASS}>{t("contentView.player.subtitles.originalRevision")}</DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={model.originalId ?? ""} onValueChange={model.setOriginal}>
                {model.originals.map((option) => (
                  <DropdownMenu.RadioItem key={option.id} value={option.id} className={PLAYER_MENU_ITEM_CLASS} data-testid={`player-subtitles-original-${option.id}`}>
                    <span className="max-w-56 truncate" title={option.label}>
                      {option.label}
                    </span>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </>
          )}
          <DropdownMenu.Separator className={SEPARATOR_CLASS} />
          <DropdownMenu.Label className={LABEL_CLASS}>{t("contentView.player.subtitles.translation")}</DropdownMenu.Label>
          {noTranslation ? (
            <>
              <p className={NOTE_CLASS}>{t("contentView.player.subtitles.noTranslation")}</p>
              <DropdownMenu.Item className={PLAYER_MENU_ITEM_CLASS} onSelect={model.goTranslate} data-testid="player-subtitles-go-translate">
                {t("contentView.player.subtitles.goTranslate")}
              </DropdownMenu.Item>
            </>
          ) : (
            <DropdownMenu.RadioGroup value={model.translationId ?? ""} onValueChange={model.setTranslation}>
              {model.translations.map((option) => (
                <DropdownMenu.RadioItem key={option.id} value={option.id} className={PLAYER_MENU_ITEM_CLASS} data-testid={`player-subtitles-translation-${option.id}`}>
                  <span className="max-w-56 truncate" title={option.label}>
                    {option.label}
                  </span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          )}
          <DropdownMenu.Separator className={SEPARATOR_CLASS} />
          <DropdownMenu.Item className={PLAYER_MENU_ITEM_CLASS} onSelect={model.startEditing} data-testid="player-subtitles-edit">
            {t("contentView.player.subtitles.editStyle")}
          </DropdownMenu.Item>
          {model.fontFallback ? <p className={NOTE_CLASS}>{t("contentView.player.subtitles.fontFallback")}</p> : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
