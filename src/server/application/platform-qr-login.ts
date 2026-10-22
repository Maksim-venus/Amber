import { monotonicFactory } from "ulid";
import { QR_ATTEMPT_TTL_MS, QR_POLL_INTERVAL_MS } from "../../shared/defaults.ts";
import type { PlatformQrAttemptDto, PlatformQrStatusDto } from "../../shared/dto/platform-account.ts";
import type { PlatformQrStatus } from "../../shared/enums.ts";
import { amberError, isAmberError } from "../domain/errors.ts";
import type { Platform } from "../domain/platform.ts";
import type { RequestPrincipal } from "../domain/user.ts";
import { OutboundHttpError } from "../ports/outbound-http.ts";
import type { PlatformQrLogin } from "../ports/platform-login.ts";
import type { PlatformAccountService } from "./platform-accounts.ts";

export interface PlatformQrLoginServiceOptions {
  logins: readonly PlatformQrLogin[];
  accounts: Pick<PlatformAccountService, "saveConfirmedLogin">;
  now?: () => number;
  newId?: () => string;
}

interface Attempt {
  readonly id: string;
  /** The platform's handle for polling; dropped once the attempt is over. */
  key: string | undefined;
  readonly expiresAt: number;
  status: PlatformQrStatus;
  /** When the platform was last asked (or the code was issued). */
  polledAt: number;
  inflight: Promise<void> | undefined;
}

interface Slot {
  current: Attempt;
  /** The attempt the current one replaced: it still answers `expired`, nothing more is kept. */
  replacedId?: string;
}

function isOver(status: PlatformQrStatus): boolean {
  return status === "confirmed" || status === "expired";
}

/**
 * QR code logins in progress (server mode). Attempts live in
 * this process only: each `(userId, platform)` keeps its latest attempt, whatever its
 * state, until a new one replaces it or the process restarts; the replaced attempt is
 * `expired`. Expiry changes the status and deletes nothing. The platform is asked at most
 * once per `QR_POLL_INTERVAL_MS` per attempt, however many clients poll, and never after
 * the attempt is over or past its `expiresAt`. A failed poll keeps the last status, so a
 * network hiccup does not end a login the user is still confirming. Only a confirmed code
 * produces a `PlatformAccount`, and only if its attempt is still the current one.
 */
export class PlatformQrLoginService {
  private readonly options: PlatformQrLoginServiceOptions;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly slots = new Map<string, Slot>();

  constructor(options: PlatformQrLoginServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? monotonicFactory();
  }

  async start(principal: RequestPrincipal, platform: Platform, signal: AbortSignal): Promise<PlatformQrAttemptDto> {
    const login = this.loginFor(platform);
    const ticket = await login.start(signal);
    const now = this.now();
    const attempt: Attempt = {
      id: this.newId(),
      key: ticket.key,
      expiresAt: ticket.expiresAt ?? now + QR_ATTEMPT_TTL_MS,
      status: "pending",
      polledAt: now,
      inflight: undefined,
    };
    const slotKey = this.slotKey(principal.userId, platform);
    const previous = this.slots.get(slotKey)?.current;
    if (previous !== undefined && !isOver(previous.status)) {
      this.end(previous, "expired");
    }
    this.slots.set(slotKey, { current: attempt, ...(previous === undefined ? {} : { replacedId: previous.id }) });
    return { attemptId: attempt.id, qrUrl: ticket.qrUrl, expiresAt: attempt.expiresAt };
  }

  async status(principal: RequestPrincipal, platform: Platform, attemptId: string, signal: AbortSignal): Promise<PlatformQrStatusDto> {
    const owner = principal.userId;
    const slot = this.slots.get(this.slotKey(owner, platform));
    if (slot !== undefined && slot.replacedId === attemptId) {
      return { status: "expired" };
    }
    const attempt = slot?.current;
    if (attempt === undefined || attempt.id !== attemptId) {
      throw amberError("not_found", "no such QR login attempt");
    }
    if (!isOver(attempt.status) && this.now() >= attempt.expiresAt) {
      this.end(attempt, "expired");
    }
    if (isOver(attempt.status)) {
      return { status: attempt.status };
    }
    if (attempt.inflight === undefined && this.now() - attempt.polledAt >= QR_POLL_INTERVAL_MS) {
      attempt.inflight = this.refresh(owner, platform, attempt, signal).finally(() => {
        attempt.inflight = undefined;
      });
    }
    await attempt.inflight;
    return { status: attempt.status };
  }

  private async refresh(owner: string, platform: Platform, attempt: Attempt, signal: AbortSignal): Promise<void> {
    const key = attempt.key;
    if (key === undefined) {
      return;
    }
    attempt.polledAt = this.now();
    let result;
    try {
      result = await this.loginFor(platform).poll(key, signal);
    } catch (error) {
      if (isAmberError(error) || error instanceof OutboundHttpError) {
        return;
      }
      throw error;
    }
    // Replaced while the platform was answering: the user is looking at another code now.
    if (this.slots.get(this.slotKey(owner, platform))?.current !== attempt || isOver(attempt.status)) {
      return;
    }
    if (result.status === "confirmed") {
      this.options.accounts.saveConfirmedLogin(owner, platform, result.cookies);
      this.end(attempt, "confirmed");
    } else if (result.status === "expired") {
      this.end(attempt, "expired");
    } else {
      attempt.status = result.status;
    }
  }

  private end(attempt: Attempt, status: "confirmed" | "expired"): void {
    attempt.status = status;
    attempt.key = undefined;
  }

  private loginFor(platform: Platform): PlatformQrLogin {
    const login = this.options.logins.find((candidate) => candidate.platform === platform);
    if (login === undefined) {
      throw amberError("not_found", "this platform has no QR login");
    }
    return login;
  }

  private slotKey(owner: string, platform: Platform): string {
    return `${owner}\u0000${platform}`;
  }
}
