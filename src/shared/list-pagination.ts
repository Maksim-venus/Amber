/**
 * Page sizes a list page offers in its pager. The default is
 * `LIST_PAGE_SIZE_DEFAULT` and must be one of these.
 */
export const LIST_PAGE_SIZES = [10, 15, 20, 50] as const;

export type ListPageSize = (typeof LIST_PAGE_SIZES)[number];

export function isListPageSize(value: number): value is ListPageSize {
  return (LIST_PAGE_SIZES as readonly number[]).includes(value);
}
