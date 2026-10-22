import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  noteDtoSchema,
  noteGroupsDtoSchema,
  noteListDtoSchema,
  type NoteCreateRequest,
  type NotePatchRequest,
} from "../../shared/dto/note.ts";
import { useApi } from "../api/context.tsx";
import { queryString } from "../api/queries.ts";
import { noteKeys } from "./note-keys.ts";

export { noteKeys };


/** A Content's notes, each placed on `revisionId` when given (`view`). */
export function useContentNotes(contentId: string, revisionId?: string, enabled = true) {
  const client = useApi();
  return useQuery({
    queryKey: noteKeys.content(contentId, revisionId),
    queryFn: () =>
      client.get(`/api/contents/${encodeURIComponent(contentId)}/notes${queryString({ revision: revisionId })}`, noteListDtoSchema),
    enabled,
  });
}

/**
 * Contents with notes, latest first, one numbered page. The key sits under `noteKeys.groups`,
 * so note and content changes re-read the page on screen; the previous page's answer stays as
 * placeholder while the next one loads (for the pager's total; the page does not show it).
 */
export function useNoteGroups(position: { page: number; pageSize: number }) {
  const client = useApi();
  return useQuery({
    queryKey: [...noteKeys.groups, position.page, position.pageSize],
    queryFn: ({ signal }) =>
      client.get(`/api/notes/groups${queryString({ limit: position.pageSize, page: position.page })}`, noteGroupsDtoSchema, { signal }),
    placeholderData: keepPreviousData,
  });
}

/**
 * One creation intent: the body is frozen and the Idempotency-Key fixed when the user acts,
 * and a retry after an unknown outcome resends both unchanged.
 */
export interface NoteCreateIntent {
  key: string;
  contentId: string;
  body: NoteCreateRequest;
}

export function newNoteIntent(contentId: string, body: NoteCreateRequest): NoteCreateIntent {
  return { key: crypto.randomUUID(), contentId, body };
}

export function useCreateNote() {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (intent: NoteCreateIntent) =>
      client.post(`/api/contents/${encodeURIComponent(intent.contentId)}/notes`, noteDtoSchema, {
        body: intent.body,
        idempotencyKey: intent.key,
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: noteKeys.all }),
  });
}

export function usePatchNote() {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { noteId: string; patch: NotePatchRequest }) =>
      client.patch(`/api/notes/${encodeURIComponent(input.noteId)}`, noteDtoSchema, { body: input.patch }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: noteKeys.all }),
  });
}

export function useDeleteNote() {
  const client = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (noteId: string) => client.delete(`/api/notes/${encodeURIComponent(noteId)}`, z.undefined()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: noteKeys.all }),
  });
}
