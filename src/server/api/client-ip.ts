import { BlockList, isIP } from "node:net";

/**
 * The client address used by login rate limiting: the socket peer, unless
 * that peer is a trusted proxy (`AMBER_TRUSTED_PROXY_CIDRS`), in which case the rightmost
 * `X-Forwarded-For` hop, the one that proxy appended. Hops further left are client-supplied
 * and never trusted.
 */
export class ClientIpResolver {
  private readonly trusted = new BlockList();
  private readonly any: boolean;

  /** Throws on a malformed CIDR so a bad configuration fails start-up. */
  constructor(trustedProxyCidrs: readonly string[] = []) {
    for (const cidr of trustedProxyCidrs) {
      const [address, prefix] = cidr.trim().split("/");
      const family = address === undefined ? 0 : isIP(address);
      const bits = Number(prefix);
      if (family === 0 || prefix === undefined || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) {
        throw new Error(`invalid trusted proxy CIDR: ${cidr}`);
      }
      this.trusted.addSubnet(address as string, bits, family === 4 ? "ipv4" : "ipv6");
    }
    this.any = trustedProxyCidrs.length > 0;
  }

  resolve(peer: string | undefined, forwardedFor: string | string[] | undefined): string {
    const address = unmapped(peer ?? "");
    if (!this.any || !this.isTrusted(address) || forwardedFor === undefined) {
      return address;
    }
    const hops = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor).split(",").map((hop) => hop.trim());
    const last = unmapped(hops.at(-1) ?? "");
    return isIP(last) === 0 ? address : last;
  }

  private isTrusted(address: string): boolean {
    const family = isIP(address);
    return family !== 0 && this.trusted.check(address, family === 4 ? "ipv4" : "ipv6");
  }
}

/** Parses the comma-separated `AMBER_TRUSTED_PROXY_CIDRS`; unset or blank means none. */
export function parseTrustedProxyCidrs(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/** `::ffff:192.0.2.1` → `192.0.2.1`, so IPv4 CIDRs match dual-stack sockets. */
function unmapped(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address);
  return mapped?.[1] ?? address;
}
