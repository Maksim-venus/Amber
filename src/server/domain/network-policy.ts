import { amberError } from "./errors.ts";

/**
 * Address ranges no user-controllable outbound request may reach unless its origin is
 * allowlisted: private, loopback, link-local, shared, documentation,
 * benchmarking, multicast and reserved space, plus the cloud metadata address. IPv4-mapped
 * (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses are judged by their embedded
 * IPv4 address instead (see `EMBEDDED_IPV4_PREFIXES`).
 */
export const FORBIDDEN_ADDRESS_RANGES: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "2001:db8::/32",
  "fd00:ec2::254/128",
];

/** IPv6 prefixes whose low 32 bits carry an IPv4 address that decides the verdict. */
const EMBEDDED_IPV4_PREFIXES: readonly string[] = ["::ffff:0:0/96", "64:ff9b::/96"];

export interface ParsedAddress {
  family: 4 | 6;
  /** The address as an unsigned integer of 32 or 128 bits. */
  value: bigint;
}

interface Range {
  family: 4 | 6;
  network: bigint;
  prefix: number;
}

/** Parses a literal IPv4 or IPv6 address (brackets and an IPv6 zone id are tolerated). */
export function parseAddress(text: string): ParsedAddress | undefined {
  const address = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  const ipv4 = parseIpv4(address);
  if (ipv4 !== undefined) {
    return { family: 4, value: ipv4 };
  }
  const ipv6 = parseIpv6(address.replace(/%.*$/u, ""));
  return ipv6 === undefined ? undefined : { family: 6, value: ipv6 };
}

function parseIpv4(text: string): bigint | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return undefined;
  }
  let value = 0n;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/u.test(part) || Number(part) > 255) {
      return undefined;
    }
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

function parseIpv6(text: string): bigint | undefined {
  if (!/^[0-9a-fA-F:.]+$/u.test(text) || text.split("::").length > 2) {
    return undefined;
  }
  let groups: string[];
  const tail: bigint[] = [];
  let body = text;
  // An embedded dotted IPv4 tail counts as the last two groups.
  const dotted = /:(\d+\.\d+\.\d+\.\d+)$/u.exec(text);
  if (dotted !== null) {
    const ipv4 = parseIpv4(dotted[1] as string);
    if (ipv4 === undefined) {
      return undefined;
    }
    tail.push(ipv4 >> 16n, ipv4 & 0xffffn);
    body = text.slice(0, -(dotted[1] as string).length);
    if (body.endsWith(":") && !body.endsWith("::")) {
      body = body.slice(0, -1);
    }
  }
  const wanted = 8 - tail.length;
  if (body.includes("::")) {
    const [head = "", rest = ""] = body.split("::");
    const left = head === "" ? [] : head.split(":");
    const right = rest === "" ? [] : rest.split(":");
    if (left.length + right.length >= wanted) {
      return undefined;
    }
    groups = [...left, ...Array<string>(wanted - left.length - right.length).fill("0"), ...right];
  } else {
    groups = body === "" ? [] : body.split(":");
    if (groups.length !== wanted) {
      return undefined;
    }
  }
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) {
      return undefined;
    }
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  for (const group of tail) {
    value = (value << 16n) | group;
  }
  return value;
}

function parseRange(cidr: string): Range {
  const [address = "", prefixText = ""] = cidr.split("/");
  const parsed = parseAddress(address);
  const prefix = Number(prefixText);
  const bits = parsed?.family === 4 ? 32 : 128;
  if (parsed === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
    throw new TypeError(`invalid address range: ${cidr}`);
  }
  return { family: parsed.family, network: parsed.value, prefix };
}

function inRange(address: ParsedAddress, range: Range): boolean {
  if (address.family !== range.family) {
    return false;
  }
  const shift = BigInt((address.family === 4 ? 32 : 128) - range.prefix);
  return address.value >> shift === range.network >> shift;
}

const embeddedPrefixes = EMBEDDED_IPV4_PREFIXES.map(parseRange);

/**
 * Whether connecting to `address` is forbidden by `ranges` (by default
 * `FORBIDDEN_ADDRESS_RANGES`). An IPv4-mapped or NAT64 IPv6 address is judged by its embedded IPv4 address.
 * Anything that is not a literal IP address is refused as well.
 */
export function isForbiddenAddress(address: string, ranges: readonly string[] = FORBIDDEN_ADDRESS_RANGES): boolean {
  const parsed = parseAddress(address);
  if (parsed === undefined) {
    return true;
  }
  const effective =
    parsed.family === 6 && embeddedPrefixes.some((prefix) => inRange(parsed, prefix))
      ? { family: 4 as const, value: parsed.value & 0xffffffffn }
      : parsed;
  return ranges.map(parseRange).some((range) => inRange(effective, range));
}

/**
 * The origin `scheme://host[:port]` of an http(s) URL as allowlist entries store it:
 * lowercase scheme and host, IDN as punycode, default ports dropped, explicit other ports
 * kept (WHATWG URL serialization).
 */
export function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * Normalizes one allowlist entry. Only an exact http(s) origin
 * is accepted: no wildcard, CIDR, pattern, credentials, path, query or fragment; a single
 * trailing slash is tolerated as the empty path.
 */
export function normalizeAllowlistOrigin(value: string): string {
  const reject = (reason: string) =>
    amberError("invalid_request", `allowlist entry ${reason}`, { code: "invalid_request.allowlist_entry" });
  const trimmed = value.trim();
  const match = /^(https?):\/\/([^/?#]*)\/?$/iu.exec(trimmed);
  if (match === null) {
    throw reject("is not an http(s) origin without path");
  }
  const authority = match[2] as string;
  if (authority === "" || /[*@\\\s^$|()?{}]/u.test(authority)) {
    throw reject("must name one exact host");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw reject("is not a valid URL");
  }
  if (url.hostname === "" || url.username !== "" || url.password !== "") {
    throw reject("must name one exact host");
  }
  return originOf(url);
}
