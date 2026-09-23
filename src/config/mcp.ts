import { z } from "zod";

export function memoryUri(value: string) {
  if (!value.startsWith("viking://") || /[%?#\\\x00-\x1f]/.test(value))
    throw new Error("MEMORY_URI_INVALID");
  const parts = value.slice(9).replace(/\/$/, "").split("/");
  if (
    parts.length < 3 ||
    parts.some((p) => !p || p === "." || p === ".." || p === "~")
  )
    throw new Error("MEMORY_URI_INVALID");
  return `viking://${parts.join("/")}`;
}

export function parseMemoryRoots(value?: string): string[] {
  if (!value) return [];
  try {
    return z
      .array(z.string())
      .min(1)
      .max(16)
      .parse(JSON.parse(value))
      .map(memoryUri);
  } catch {
    throw new Error("INVALID_MEMORY_ROOTS");
  }
}
