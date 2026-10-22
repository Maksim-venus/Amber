import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CredentialsSection } from "../../../../src/web/pages/admin/credentials-section.tsx";
import { fakeShell } from "../../../fixtures/web/desktop-bridge.ts";
import { mockApi, renderApp } from "../../../fixtures/web/render.tsx";

vi.mock("../../../../src/web/desktop/bridge.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...(await import("../../../fixtures/web/desktop-bridge.ts")).fakeBridge,
}));

async function reset(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "重置全部凭据" }));
  fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "重置全部凭据" }));
  expect(await screen.findByText(/已于 .* 重置全部凭据/)).toBeTruthy();
}

describe("CredentialsSection", () => {
  it("has the desktop shell replace the master key after the reset, and lets a failed rotation be retried", async () => {
    fakeShell.desktop = true;
    fakeShell.rotateMasterKey.mockRejectedValueOnce("keyring locked").mockResolvedValueOnce(undefined);
    mockApi({ "POST /api/admin/credentials/reset": { body: { credentialsResetAt: 1_790_000_000_000 } } });
    renderApp(<CredentialsSection />, { mode: "local" });
    await waitFor(() => expect(screen.getByRole("button", { name: "重置全部凭据" })).toBeTruthy());
    // Let the desktop check settle before acting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reset();
    const failed = await screen.findByTestId("rotate-failed");
    expect(failed.textContent).toContain("凭据已重置，但更新系统凭据管理器中的主密钥失败");
    expect(failed.textContent).toContain("keyring locked");
    fireEvent.click(within(failed).getByRole("button", { name: "重试更新主密钥" }));
    await waitFor(() => expect(screen.queryByTestId("rotate-failed")).toBeNull());
    expect(fakeShell.rotateMasterKey).toHaveBeenCalledTimes(2);
    // The reset revokes the bilibili login, so the player iframe loses it once as well.
    expect(fakeShell.clearBilibiliPlayerSession).toHaveBeenCalledTimes(1);
  });

  it("still replaces the master key when clearing the player session fails", async () => {
    fakeShell.desktop = true;
    fakeShell.clearBilibiliPlayerSession.mockRejectedValueOnce("webview busy");
    fakeShell.rotateMasterKey.mockResolvedValueOnce(undefined);
    mockApi({ "POST /api/admin/credentials/reset": { body: { credentialsResetAt: 1_790_000_000_000 } } });
    renderApp(<CredentialsSection />, { mode: "local" });
    await waitFor(() => expect(screen.getByRole("button", { name: "重置全部凭据" })).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await reset();
    await waitFor(() => expect(fakeShell.rotateMasterKey).toHaveBeenCalledTimes(1));
    expect(fakeShell.clearBilibiliPlayerSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("rotate-failed")).toBeNull();
  });

  it("never touches the shell in server mode", async () => {
    fakeShell.desktop = true;
    mockApi({ "POST /api/admin/credentials/reset": { body: { credentialsResetAt: 1_790_000_000_000 } } });
    renderApp(<CredentialsSection />, { mode: "server" });
    await reset();
    expect(fakeShell.rotateMasterKey).not.toHaveBeenCalled();
    expect(fakeShell.clearBilibiliPlayerSession).not.toHaveBeenCalled();
  });
});
