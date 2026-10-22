import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import type { NoteColor, NoteMark } from "../../shared/enums.ts";
import type { SelectionRect } from "../chat/selection-toolbar.tsx";
import { useContentPage } from "../pages/content/content-context.tsx";
import type { NoteAnchor } from "./note-anchor.ts";
import { rememberedColor } from "./note-colors.ts";
import type { NoteCreateIntent } from "./queries.ts";

/** The notes of one run in the reading view; `noteIds` newest first. */
export interface NoteViewTarget {
  kind: "view";
  noteIds: string[];
  segmentId: string;
  revisionId: string;
}

/** A comment note being written before anything is saved. */
export interface ComposeDraft {
  mark: NoteMark;
  color: NoteColor;
  comment: string;
  /** The request frozen by the last 保存, resent unchanged by a retry. */
  intent?: NoteCreateIntent;
}

export interface NoteComposeTarget {
  kind: "compose";
  anchor: NoteAnchor;
  /** Where the selection was when 评论 was pressed; the selection itself is gone by then. */
  rect: SelectionRect;
  excerpt: string;
  draft: ComposeDraft;
}

export type NoteTarget = NoteViewTarget | NoteComposeTarget;

/** An unsaved comment edit on an existing note. */
export interface CommentDraft {
  text: string;
  /** The comment it started from, so an untouched edit is not unsaved work. */
  original: string;
}

/** Scrolls the reading view to a sentence of `revisionId`; false when that view is not shown. */
export type SentenceLocator = (revisionId: string, segmentId: string) => boolean;

export interface NotesUi {
  target: NoteTarget | undefined;
  /** Opens the notes of a run; refused (false) while unsaved work is open. */
  openView(target: Omit<NoteViewTarget, "kind">): boolean;
  /** Starts a comment note on a frozen selection; refused (false) while unsaved work is open. */
  openCompose(input: { anchor: NoteAnchor; rect: SelectionRect; excerpt: string }): boolean;
  updateCompose(patch: Partial<ComposeDraft>): void;
  commentDrafts: ReadonlyMap<string, CommentDraft>;
  setCommentDraft(noteId: string, draft: CommentDraft | undefined): void;
  /** A comment typed and not saved: the popover then refuses to close by Esc or an outside press. */
  dirty: boolean;
  /** An attempt to close was refused because of unsaved work. */
  warned: boolean;
  warn(): void;
  /** Ends the target and drops every draft: 取消, a successful save, or a close that is allowed. */
  close(): void;
  /** Brings a sentence back into view without seeking, switching to its revision when needed. */
  locate(revisionId: string, segmentId: string): void;
  registerLocator(locator: SentenceLocator): () => void;
}

const Context = createContext<NotesUi | undefined>(undefined);

function isDirty(target: NoteTarget | undefined, drafts: ReadonlyMap<string, CommentDraft>): boolean {
  if (target?.kind === "compose" && target.draft.comment.trim() !== "") return true;
  for (const draft of drafts.values()) {
    if (draft.text.trim() !== "" && draft.text !== draft.original) return true;
  }
  return false;
}

/**
 * Page-level state of the note popover: one target at a time and the drafts
 * typed in it. It lives above the tabs, so switching tab or version keeps unsaved comments;
 * leaving the Content page drops them.
 */
export function NotesUiProvider(props: { children: ReactNode }) {
  const page = useContentPage();
  const [params, setParams] = useSearchParams();
  const [target, setTarget] = useState<NoteTarget | undefined>(undefined);
  const [commentDrafts, setCommentDrafts] = useState<ReadonlyMap<string, CommentDraft>>(new Map());
  const [warned, setWarned] = useState(false);
  const locators = useRef(new Set<SentenceLocator>());
  const dirty = isDirty(target, commentDrafts);

  const close = useCallback(() => {
    setTarget(undefined);
    setCommentDrafts(new Map());
    setWarned(false);
  }, []);

  const locate = useCallback(
    (revisionId: string, segmentId: string) => {
      for (const locator of locators.current) {
        if (locator(revisionId, segmentId)) return;
      }
      // Not on screen in that revision: select it there (no seek) and let the reader scroll to it.
      page.select({ revisionId, segmentId });
      const next = new URLSearchParams(params);
      next.set("tab", "transcript");
      next.set("revision", revisionId);
      next.set("segment", segmentId);
      setParams(next, { replace: true });
    },
    [page, params, setParams],
  );

  const value = useMemo<NotesUi>(
    () => ({
      target,
      openView: (next) => {
        if (dirty) {
          setWarned(true);
          return false;
        }
        setCommentDrafts(new Map());
        setWarned(false);
        setTarget({ kind: "view", ...next });
        return true;
      },
      openCompose: (input) => {
        if (dirty) {
          setWarned(true);
          return false;
        }
        setCommentDrafts(new Map());
        setWarned(false);
        setTarget({ kind: "compose", ...input, draft: { mark: "underline", color: rememberedColor("underline"), comment: "" } });
        return true;
      },
      updateCompose: (patch) => {
        setTarget((current) => (current?.kind === "compose" ? { ...current, draft: { ...current.draft, ...patch } } : current));
      },
      commentDrafts,
      setCommentDraft: (noteId, draft) => {
        setCommentDrafts((current) => {
          const next = new Map(current);
          if (draft === undefined) next.delete(noteId);
          else next.set(noteId, draft);
          return next;
        });
      },
      dirty,
      warned,
      warn: () => setWarned(true),
      close,
      locate,
      registerLocator: (locator) => {
        locators.current.add(locator);
        return () => {
          locators.current.delete(locator);
        };
      },
    }),
    [target, commentDrafts, dirty, warned, close, locate],
  );

  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}

export function useNotesUi(): NotesUi {
  const value = useContext(Context);
  if (value === undefined) throw new Error("NotesUiProvider missing");
  return value;
}

/** The notes UI where there is one (the Content page); the notes page has none. */
export function useOptionalNotesUi(): NotesUi | undefined {
  return useContext(Context);
}
