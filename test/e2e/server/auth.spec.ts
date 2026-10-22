import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_ADMIN, E2E_SERVER_PORT } from "./constants.ts";
import { seedContent, seedSummary, userIdOf } from "./seed.ts";

// One backend for the whole project: the first test changes the preset password, the
// others log in with the new one.
test.describe.configure({ mode: "serial" });

const ORIGIN = `http://127.0.0.1:${E2E_SERVER_PORT}`;
/** What the SPA sends on every state-changing call to pass the CSRF check. */
const CSRF = { "x-amber-request": "1", origin: ORIGIN };

async function logIn(page: Page, password: string): Promise<void> {
  const form = page.getByTestId("login-form");
  await form.getByLabel("用户名").fill(E2E_ADMIN.username);
  await form.getByLabel("密码", { exact: true }).fill(password);
  await form.getByRole("button", { name: "登录" }).click();
}

/**
 * The session cookie of an API login, as a request header: Playwright's API cookie jar does
 * not keep a `Secure` cookie received over plain http, which browsers do accept from a
 * loopback origin.
 */
async function apiLogin(request: APIRequestContext): Promise<string> {
  const response = await request.post("/api/auth/login", { headers: CSRF, data: { username: E2E_ADMIN.username, password: E2E_ADMIN.password } });
  expect(response.status()).toBe(200);
  const cookie = /^(__Host-amber-session=[^;]+)/u.exec(response.headers()["set-cookie"] ?? "")?.[1];
  expect(cookie).toBeDefined();
  return cookie ?? "";
}

test("an unauthenticated deep link goes to /login, the forced password change follows, then the page returns", async ({ page }) => {
  await page.goto("/collections");
  await expect(page).toHaveURL(/\/login$/u);
  await logIn(page, E2E_ADMIN.initialPassword);

  const change = page.getByTestId("change-password-form");
  await change.getByLabel("新密码", { exact: true }).fill(E2E_ADMIN.password);
  await change.getByLabel("确认新密码").fill(E2E_ADMIN.password);
  await change.getByRole("button", { name: "保存新密码" }).click();
  await expect(page).toHaveURL(/\/collections$/u);
  await expect(page.getByTestId("account-card")).toHaveText(E2E_ADMIN.username);

  // A later visit with a fresh browser context starts at the login page again.
  await page.context().clearCookies();
  await page.goto("/library");
  await expect(page).toHaveURL(/\/login$/u);
  await logIn(page, E2E_ADMIN.password);
  await expect(page).toHaveURL(/\/library$/u);
});

test("deep links reload into the SPA; unknown /api paths answer 401 without and 404 with a session", async ({ request }) => {
  for (const path of ["/setup", "/login", "/new", "/contents/x"]) {
    const response = await request.get(path);
    expect([path, response.status()]).toEqual([path, 200]);
    expect(await response.text()).toContain('<div id="root">');
  }
  const anonymous = await request.get("/api/nope");
  expect(anonymous.status()).toBe(401);
  expect((await anonymous.json()).error.class).toBe("unauthenticated");

  const cookie = await apiLogin(request);
  const known = await request.get("/api/nope", { headers: { cookie } });
  expect(known.status()).toBe(404);
  expect((await known.json()).error.class).toBe("not_found");
});

const XSS_MARK = "amber-xss";
/** SRT cue lines: tags are formatting markup an importer strips; entities decode to literal text. */
const HOSTILE = [
  `<script>console.log("${XSS_MARK}")</script>`,
  `<img src=x onerror="console.log('${XSS_MARK}')">`,
  `<b onmouseover="console.log('${XSS_MARK}')">粗体原文</b>`,
  `&lt;i onmouseover="console.log('${XSS_MARK}')"&gt;转义原文&lt;/i&gt;`,
];

test("untrusted subtitle and summary text never executes and the CSP header is sent", async ({ page }) => {
  const executed: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes(XSS_MARK)) executed.push(message.text());
  });
  page.on("dialog", (dialog) => {
    executed.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });

  await page.goto("/login");
  await logIn(page, E2E_ADMIN.password);
  await expect(page).toHaveURL(/\/library$/u);

  const contentId = seedContent(userIdOf(E2E_ADMIN.username), `<img src=x onerror="console.log('${XSS_MARK}')">标题`);
  const srt = HOSTILE.map((line, index) => `${index + 1}\n00:00:0${index},000 --> 00:00:0${index},900\n${line}\n`).join("\n");
  // From the page itself, like the SPA: the browser holds the session cookie.
  const status = await page.evaluate(
    async ({ url, body }) =>
      (await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-amber-request": "1" }, body: JSON.stringify(body) })).status,
    { url: `/api/contents/${contentId}/subtitle-import`, body: { text: srt, format: "srt", language: "en" } },
  );
  expect(status).toBe(201);
  seedSummary(userIdOf(E2E_ADMIN.username), contentId, (citation) =>
    [
      "## 摘要",
      `- <script>console.log("${XSS_MARK}")</script> 脚本 ${citation}`,
      `- [危险链接](javascript:console.log('${XSS_MARK}'))`,
      `- <img src=x onerror="console.log('${XSS_MARK}')">`,
      `- <span onclick="console.log('${XSS_MARK}')">事件属性</span>`,
    ].join("\n"),
  );

  const document = await page.goto(`/contents/${contentId}?tab=summary`);
  expect(document?.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(document?.headers()["x-content-type-options"]).toBe("nosniff");
  const summary = page.getByTestId("summary-body");
  await expect(summary).toContainText("危险链接");
  // Raw HTML is shown escaped, as the characters it is made of.
  await expect(summary).toContainText(`<span onclick="console.log('${XSS_MARK}')">事件属性</span>`);
  await expect(summary).toContainText(`<script>console.log("${XSS_MARK}")</script>`);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator("main script, main img[onerror], main [onclick], main [onmouseover]")).toHaveCount(0);
  await summary.getByText("事件属性", { exact: false }).click();
  // The hostile title renders as text in the heading and the sidebar.
  await expect(page.getByRole("heading", { level: 1 })).toContainText("<img src=x onerror=");

  await page.goto(`/contents/${contentId}?tab=transcript`);
  const transcript = page.getByRole("tabpanel");
  await expect(transcript).toContainText("粗体原文");
  await expect(transcript).toContainText(`<i onmouseover="console.log('${XSS_MARK}')">转义原文</i>`);
  await expect(page.locator("main [onmouseover], main script, main img[onerror]")).toHaveCount(0);
  await transcript.getByText("转义原文", { exact: false }).first().hover();
  expect(executed).toEqual([]);
});

test("instance settings: the administrator edits them under /admin, a regular user is refused", async ({ page, browser }) => {
  await page.goto("/login");
  await logIn(page, E2E_ADMIN.password);
  await expect(page).toHaveURL(/\/library$/u);

  await page.goto("/admin/instance");
  const concurrency = page.locator("#concurrency");
  await concurrency.getByLabel("同时处理的任务数").fill("3");
  await concurrency.getByRole("button", { name: "保存" }).click();
  await expect(concurrency.getByRole("button", { name: "保存" })).toBeDisabled();
  await page.reload();
  await expect(page.locator("#concurrency").getByLabel("同时处理的任务数")).toHaveValue("3");

  // A regular account, created the way the users page does.
  const member = { username: "e2e-member", initialPassword: "<member-initial-pw>", password: "<member-changed-pw>" };
  const created = await page.evaluate(
    async (body) =>
      (await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json", "x-amber-request": "1" }, body: JSON.stringify(body) })).status,
    { username: member.username, password: member.initialPassword, role: "user" },
  );
  expect(created).toBe(201);

  const context = await browser.newContext();
  const other = await context.newPage();
  await other.goto("/login");
  const form = other.getByTestId("login-form");
  await form.getByLabel("用户名").fill(member.username);
  await form.getByLabel("密码", { exact: true }).fill(member.initialPassword);
  await form.getByRole("button", { name: "登录" }).click();
  const change = other.getByTestId("change-password-form");
  await change.getByLabel("新密码", { exact: true }).fill(member.password);
  await change.getByLabel("确认新密码").fill(member.password);
  await change.getByRole("button", { name: "保存新密码" }).click();
  await expect(other).toHaveURL(/\/library$/u);

  await other.goto("/admin/instance");
  await expect(other.getByText("只有服务器管理员可以进入系统管理")).toBeVisible();
  const statuses = await other.evaluate(async () => [
    (await fetch("/api/instance-settings")).status,
    (await fetch("/api/instance-settings", { method: "PATCH", headers: { "content-type": "application/json", "x-amber-request": "1" }, body: '{"concurrencyPipeline":1}' })).status,
  ]);
  expect(statuses).toEqual([403, 403]);
  await context.close();
});
