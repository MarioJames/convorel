/** Select top-level JSON fields without changing the command's result or state. */
export function jsonPrinter(fields?: string) {
  const keys = fields?.split(",").map((key) => key.trim());
  if (keys?.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
    throw new Error(
      "INVALID_FIELDS: expected comma-separated top-level field names",
    );
  const select = (value: unknown): unknown => {
    if (!keys) return value;
    if (Array.isArray(value)) return value.map(select);
    return Object.fromEntries(
      keys.map((key) => [
        key,
        value !== null && typeof value === "object" && Object.hasOwn(value, key)
          ? ((value as Record<string, unknown>)[key] ?? null)
          : null,
      ]),
    );
  };
  return (value: unknown) =>
    console.log(JSON.stringify(select(value), null, 2));
}
