/** Every note query sits under `["notes"]`, so any note mutation refreshes them all. */
export const noteKeys = {
  all: ["notes"] as const,
  content: (contentId: string, revisionId?: string) => ["notes", "content", contentId, revisionId ?? ""] as const,
  contentAll: (contentId: string) => ["notes", "content", contentId] as const,
  groups: ["notes", "groups"] as const,
};
