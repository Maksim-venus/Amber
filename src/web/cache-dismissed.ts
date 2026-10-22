/**
 * Per Content, the cache Task whose progress card the user closed, so a reload does not
 * bring it back. Moving the Content to the trash keeps it, since a restore
 * brings the Content back as it was; only purging forgets it.
 */
export function cacheDismissedStorageKey(contentId: string): string {
  return `amber.cache.dismissed.${contentId}`;
}

/** Private mode without storage: nothing was remembered, so nothing is left behind. */
export function forgetCacheDismissal(contentId: string): void {
  try {
    localStorage.removeItem(cacheDismissedStorageKey(contentId));
  } catch {
    // Nothing to clean up.
  }
}
