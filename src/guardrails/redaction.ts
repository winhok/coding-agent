const SENSITIVE_KEY =
  /(?:authorization|cookie|password|secret|token|api[_-]?key)/i;
const CREDENTIAL_PATTERN =
  /(?:sk-[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9]{20,}|AKIA[0-9A-Z]{16}|bearer\s+[a-z0-9._~+/=-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/gi;

export function redactSensitiveValue(
  value: unknown,
  knownSecrets: readonly string[] = [],
  key = "",
  depth = 0,
): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    let redacted = value.replace(CREDENTIAL_PATTERN, "[REDACTED]");
    for (const secret of knownSecrets) {
      if (secret.length < 4) continue;
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[MAX_DEPTH]";
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => redactSensitiveValue(item, knownSecrets, "", depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([entryKey, entryValue]) => [
        entryKey,
        redactSensitiveValue(entryValue, knownSecrets, entryKey, depth + 1),
      ]),
  );
}
