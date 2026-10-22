/**
 * Deterministic JSON: object keys sorted at every level, no whitespace, `undefined`
 * members dropped. Two values that mean the same request serialize identically, which
 * request digests and intent comparison rely on.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) {
        sorted[key] = sortKeys(member);
      }
    }
    return sorted;
  }
  return value;
}
