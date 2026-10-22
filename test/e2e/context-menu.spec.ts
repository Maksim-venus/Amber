import { expect, test } from "@playwright/test";
import { BILIBILI_BVID, installMockBackend } from "./mock-backend.ts";

test("context menu: a library row offers the source link and rename; blank space keeps the browser menu", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installMockBackend(page);
  await page.goto("/library");

  const row = page.getByTestId("library-row").first();
  await expect(row).toBeVisible();

  // Blank space: the page does not intercept, so the browser's own menu stays.
  const blankPrevented = await page.evaluate(() => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(blankPrevented).toBe(false);

  await row.locator("td").nth(2).click({ button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toContainText(["打开", "复制来源链接", "重命名"]);

  await page.getByTestId("context-menu-item-copy-source-url").click();
  await expect(menu).toHaveCount(0);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://www.bilibili.com/video/${BILIBILI_BVID}`);

  await row.locator("td").nth(2).click({ button: "right" });
  await page.getByTestId("context-menu-item-rename").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("textbox")).toBeFocused();
});
