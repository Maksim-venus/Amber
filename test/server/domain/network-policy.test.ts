import { describe, expect, it } from "vitest";
import { isAmberError } from "../../../src/server/domain/errors.ts";
import { FORBIDDEN_ADDRESS_RANGES, isForbiddenAddress, normalizeAllowlistOrigin, originOf, parseAddress } from "../../../src/server/domain/network-policy.ts";

function codeOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (isAmberError(error)) return error.appError.code;
    throw error;
  }
  throw new Error("expected a rejection");
}

/** Forbidden IPv4 ranges in abbreviated form: `10/8` stands for `10.0.0.0/8`. */
const FORBIDDEN_IPV4 = [
  "0.0.0.0/8",
  "10/8",
  "100.64/10",
  "127/8",
  "169.254/16",
  "172.16/12",
  "192.0.0/24",
  "192.0.2/24",
  "192.168/16",
  "198.18/15",
  "198.51.100/24",
  "203.0.113/24",
  "224/4",
  "240/4",
];

/**
 * Forbidden IPv6 ranges plus the cloud metadata address. `::ffff:0:0/96` and `64:ff9b::/96`
 * are not listed: an IPv4-mapped or NAT64 address is judged by the IPv4 address it embeds.
 */
const FORBIDDEN_IPV6 = ["::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32", "fd00:ec2::254/128"];

describe("FORBIDDEN_ADDRESS_RANGES", () => {
  it("lists every forbidden range except the two judged by their embedded IPv4", () => {
    expect(FORBIDDEN_IPV4).toHaveLength(14);
    expect(FORBIDDEN_IPV6).toHaveLength(7);
    expect([...FORBIDDEN_ADDRESS_RANGES].sort()).toEqual([...FORBIDDEN_IPV4.map(expand), ...FORBIDDEN_IPV6].sort());
  });
});

/** `10/8` → `10.0.0.0/8`. */
function expand(range: string): string {
  const [address = "", prefix = ""] = range.split("/");
  const parts = address.split(".");
  while (parts.length < 4) parts.push("0");
  return `${parts.join(".")}/${prefix}`;
}

describe("isForbiddenAddress", () => {
  it("refuses private, loopback, link-local, metadata and reserved addresses", () => {
    for (const address of ["0.0.0.0", "10.0.0.5", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.168.1.1",
      "198.19.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1%eth0", "ff02::1",
      "2001:db8::1", "fd00:ec2::254", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "[::1]"]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
  });

  it("admits public addresses, including IPv4-mapped and NAT64 forms of public IPv4", () => {
    for (const address of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"]) {
      expect(isForbiddenAddress(address), address).toBe(false);
    }
  });

  it("refuses anything that is not an address and accepts injected ranges", () => {
    expect(isForbiddenAddress("example.com")).toBe(true);
    expect(isForbiddenAddress("1.2.3")).toBe(true);
    expect(isForbiddenAddress("127.0.0.1", ["127.0.0.2/32"])).toBe(false);
    expect(isForbiddenAddress("127.0.0.2", ["127.0.0.2/32"])).toBe(true);
    expect(parseAddress("::ffff:1.2.3.4")).toEqual({ family: 6, value: 0xffff01020304n });
    expect(parseAddress("1::2::3")).toBeUndefined();
  });
});

describe("normalizeAllowlistOrigin", () => {
  it("normalizes scheme, host, IDN and ports", () => {
    expect(normalizeAllowlistOrigin(" HTTP://Relay.LAN:8080 ")).toBe("http://relay.lan:8080");
    expect(normalizeAllowlistOrigin("https://relay.example/")).toBe("https://relay.example");
    expect(normalizeAllowlistOrigin("https://bücher.example")).toBe("https://xn--bcher-kva.example");
    expect(normalizeAllowlistOrigin("http://10.0.0.5")).toBe("http://10.0.0.5");
    expect(normalizeAllowlistOrigin("http://[FD00::1]:9000")).toBe("http://[fd00::1]:9000");
    // The default port is the same origin as no port.
    expect(normalizeAllowlistOrigin("https://relay.example:443")).toBe("https://relay.example");
  });

  it("rejects wildcards, CIDR, patterns, paths, credentials and other schemes", () => {
    for (const entry of ["*.example.com", "https://*.example.com", "10.0.0.0/8", "http://10.0.0.0/8", "https://relay.example/v1", "https://relay.example?x=1",
      "https://relay.example#a", "https://user:pw@relay.example", "ftp://relay.example", "^https://.*$", "relay.example", "", "https://"]) {
      expect(codeOf(() => normalizeAllowlistOrigin(entry)), entry).toBe("invalid_request.allowlist_entry");
    }
  });

  it("matches the origin of request URLs", () => {
    expect(originOf(new URL("HTTPS://Relay.Example:443/v1/chat?x=1"))).toBe(normalizeAllowlistOrigin("https://relay.example"));
    expect(originOf(new URL("http://relay.lan:8080/v1"))).toBe("http://relay.lan:8080");
  });
});
