import { expect, test, type Page } from "@playwright/test";
import { LIST_PAGE_SIZE_DEFAULT } from "../../src/shared/defaults.ts";
import { installMockBackend } from "./mock-backend.ts";

/*
 * List pagination on the library page: the pager under the list turns pages
 * through the URL, changes the page size, and steps aside while a search lists its hits.
 */

const SYNTHETIC = 25;
const LARGEST_PAGE_SIZE = 50;

/** The library's total as the pager states it (「共 N 条」); the fixtures add to the synthetic rows. */
async function libraryTotal(page: Page): Promise<number> {
  const text = (await page.getByRole("navigation", { name: "分页" }).getByText(/^共 \d+ 条$/).textContent()) ?? "";
  return Number(/\d+/.exec(text)?.[0]);
}

test("the library pages through its Contents with the pager under the list", async ({ page }) => {
  await installMockBackend(page, { libraryContents: SYNTHETIC });
  await page.goto("/library");
  const rows = page.getByTestId("library-row");
  const pager = page.getByRole("navigation", { name: "分页" });

  await expect(rows).toHaveCount(LIST_PAGE_SIZE_DEFAULT);
  const total = await libraryTotal(page);
  expect(total).toBeGreaterThanOrEqual(SYNTHETIC);
  expect(total).toBeLessThanOrEqual(LARGEST_PAGE_SIZE);
  const pageCount = Math.ceil(total / LIST_PAGE_SIZE_DEFAULT);
  await expect(pager.locator('[aria-current="page"]')).toHaveText(`第 1 / ${pageCount} 页`);

  await pager.getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/[?&]page=2&pageSize=10(&|$)/);
  await expect(pager.locator('[aria-current="page"]')).toHaveText(`第 2 / ${pageCount} 页`);
  await expect(rows).toHaveCount(LIST_PAGE_SIZE_DEFAULT);

  await pager.getByRole("spinbutton", { name: "跳转到页码" }).fill(String(pageCount));
  await pager.getByRole("button", { name: "跳转" }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]page=${pageCount}&pageSize=10(&|$)`));
  await expect(pager.locator('[aria-current="page"]')).toHaveText(`第 ${pageCount} / ${pageCount} 页`);
  await expect(rows).toHaveCount(total - (pageCount - 1) * LIST_PAGE_SIZE_DEFAULT);

  // A larger page size starts again on page 1 and here fits everything on it.
  await pager.getByRole("combobox", { name: "每页条数" }).selectOption(String(LARGEST_PAGE_SIZE));
  await expect(page).toHaveURL(new RegExp(`[?&]pageSize=${LARGEST_PAGE_SIZE}(&|$)`));
  expect(new URL(page.url()).searchParams.has("page")).toBe(false);
  await expect(rows).toHaveCount(total);
  await expect(pager.locator('[aria-current="page"]')).toHaveText("第 1 / 1 页");

  // Search hits are listed whole: no pager while a query is in effect.
  await page.getByTestId("library-search").fill("B 站");
  await expect(pager).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await page.getByTestId("library-search").fill("");
  await expect(rows).toHaveCount(total);
  await expect(pager).toBeVisible();
});
