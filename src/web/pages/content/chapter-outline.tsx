import { ListTree } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "../../format.ts";
import { Button } from "../../ui/button.tsx";

/** One chapter heading of the reading view; `index` is its row in the reader. */
export interface ChapterOutlineEntry {
  index: number;
  startMs: number;
  title: string;
}

/**
 * The chapter list of the reading view, opened from its toolbar. Non-modal so
 * the wheel keeps scrolling the text underneath and a click outside both closes the list and
 * still does what it would have done. Picking an entry only moves the reader; it never seeks.
 */
export function ChapterOutline(props: { entries: readonly ChapterOutlineEntry[]; onPick: (index: number) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const empty = props.entries.length === 0;
  return (
    <Popover.Root open={open && !empty} onOpenChange={setOpen} modal={false}>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" disabled={empty} title={empty ? t("contentView.transcript.noChapters") : undefined} data-testid="chapter-outline">
          <ListTree size={14} />
          {t("contentView.transcript.chapters")}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        {/* No Popover.Arrow: it measures itself with ResizeObserver and the list needs no pointer. */}
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="z-50 flex max-h-[60vh] w-80 flex-col overflow-auto rounded-md border border-line bg-surface p-1 text-sm shadow-lg"
        >
          <p className="px-2 py-1.5 text-xs font-semibold text-muted">{t("contentView.transcript.chapterOutline", { count: props.entries.length })}</p>
          <ul data-testid="chapter-outline-list">
            {props.entries.map((entry) => (
              <li key={entry.index}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left hover:bg-sunken focus-visible:bg-sunken focus-visible:outline-none"
                  onClick={() => {
                    props.onPick(entry.index);
                    setOpen(false);
                  }}
                  data-testid="chapter-outline-item"
                >
                  <span className="shrink-0 font-mono text-xs text-accent">{formatDuration(entry.startMs)}</span>
                  <span className="min-w-0 truncate">{entry.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
