import { randomBytes } from "node:crypto";
import { argon2id, argon2Verify } from "hash-wasm";
import { ARGON2_ITERATIONS, ARGON2_MEMORY_KIB, ARGON2_PARALLELISM } from "../../../../shared/defaults.ts";
import type { PasswordHasher } from "../../../ports/password-hasher.ts";

const SALT_BYTES = 16;
const HASH_BYTES = 32;

export interface Argon2Parameters {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

const DEFAULT_PARAMETERS: Argon2Parameters = {
  memoryKiB: ARGON2_MEMORY_KIB,
  iterations: ARGON2_ITERATIONS,
  parallelism: ARGON2_PARALLELISM,
};

/** `$argon2id$v=19$m=<kib>,t=<iterations>,p=<parallelism>$<salt>$<hash>` */
const PHC_PARAMETERS = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/u;

/**
 * argon2id in pure WASM. The parameters are encoded into the PHC string, so
 * a hash made with weaker parameters still verifies and asks to be re-hashed.
 */
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly parameters: Argon2Parameters;

  constructor(parameters: Argon2Parameters = DEFAULT_PARAMETERS) {
    this.parameters = parameters;
  }

  hash(password: string): Promise<string> {
    return argon2id({
      password,
      salt: randomBytes(SALT_BYTES),
      memorySize: this.parameters.memoryKiB,
      iterations: this.parameters.iterations,
      parallelism: this.parameters.parallelism,
      hashLength: HASH_BYTES,
      outputType: "encoded",
    });
  }

  async verify(passwordHash: string, password: string): Promise<{ valid: boolean; needsRehash: boolean }> {
    const encoded = PHC_PARAMETERS.exec(passwordHash);
    if (encoded === null) {
      return { valid: false, needsRehash: false };
    }
    let valid: boolean;
    try {
      valid = await argon2Verify({ password, hash: passwordHash });
    } catch {
      return { valid: false, needsRehash: false };
    }
    const [memoryKiB, iterations, parallelism] = encoded.slice(1, 4).map(Number) as [number, number, number];
    const needsRehash =
      memoryKiB < this.parameters.memoryKiB || iterations < this.parameters.iterations || parallelism !== this.parameters.parallelism;
    return { valid, needsRehash: valid && needsRehash };
  }
}
