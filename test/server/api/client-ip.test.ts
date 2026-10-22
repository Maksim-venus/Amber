import { describe, expect, it } from "vitest";
import { ClientIpResolver, parseTrustedProxyCidrs } from "../../../src/server/api/client-ip.ts";

describe("ClientIpResolver", () => {
  it("uses the socket peer unless it is a trusted proxy, then the rightmost forwarded hop", () => {
    const resolver = new ClientIpResolver(["172.18.0.0/16", "fd00::/8"]);
    expect(resolver.resolve("203.0.113.5", "192.0.2.1")).toBe("203.0.113.5");
    expect(resolver.resolve("172.18.0.3", "1.1.1.1, 192.0.2.1")).toBe("192.0.2.1");
    expect(resolver.resolve("::ffff:172.18.0.3", ["1.1.1.1", "192.0.2.9"])).toBe("192.0.2.9");
    expect(resolver.resolve("fd00::1", "2001:db8::7")).toBe("2001:db8::7");
    // A trusted proxy that sent no usable hop falls back to itself.
    expect(resolver.resolve("172.18.0.3", undefined)).toBe("172.18.0.3");
    expect(resolver.resolve("172.18.0.3", "garbage")).toBe("172.18.0.3");
  });

  it("trusts nobody by default and refuses malformed CIDRs", () => {
    expect(new ClientIpResolver().resolve("10.0.0.1", "192.0.2.1")).toBe("10.0.0.1");
    for (const cidr of ["10.0.0.0", "10.0.0.0/33", "nonsense/8", "::/129"]) {
      expect(() => new ClientIpResolver([cidr]), cidr).toThrow(/CIDR/);
    }
    expect(parseTrustedProxyCidrs(" 10.0.0.0/8, ,172.16.0.0/12 ")).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(parseTrustedProxyCidrs(undefined)).toEqual([]);
  });
});
