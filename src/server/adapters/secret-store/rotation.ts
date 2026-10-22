import type { MasterKeyRotation } from "../../ports/master-key-rotation.ts";
import type { AesGcmSecretStore } from "./aes-gcm-secret-store.ts";
import { replaceMasterKeyFile } from "./master-key.ts";

/**
 * How the server got its master key. `external_env`: the operator set `AMBER_SECRET_KEY`,
 * which Amber uses as is and never replaces. `managed_persistent`: no env key, so Amber keeps
 * the key in `<dataDir>/secrets/master.key`, generated once at the instance's first boot and
 * never regenerated on later starts. Env and file both present is a startup failure.
 */
export type KeyMode = "external_env" | "managed_persistent";

/**
 * Master key replacement after "reset all credentials". Server
 * `managed_persistent`: a new `secrets/master.key` replaces the old one and the running
 * store switches to it. `external_env`: the operator's `AMBER_SECRET_KEY` stays in use.
 * Local mode never rotates here: the desktop shell rotates the key in Credential Manager
 * and restarts the sidecar.
 */
export class ServerMasterKeyRotation implements MasterKeyRotation {
  private readonly keyMode: KeyMode;
  private readonly secretsDir: string;
  private readonly store: Pick<AesGcmSecretStore, "replaceMasterKey">;

  constructor(options: { keyMode: KeyMode; secretsDir: string; store: Pick<AesGcmSecretStore, "replaceMasterKey"> }) {
    this.keyMode = options.keyMode;
    this.secretsDir = options.secretsDir;
    this.store = options.store;
  }

  async rotate(): Promise<void> {
    if (this.keyMode === "external_env") {
      return;
    }
    const key = replaceMasterKeyFile(this.secretsDir);
    this.store.replaceMasterKey(key);
    key.fill(0);
  }
}

/** The sidecar leaves its key alone; the shell owns it. */
export const LOCAL_MASTER_KEY_ROTATION: MasterKeyRotation = { rotate: async () => undefined };
