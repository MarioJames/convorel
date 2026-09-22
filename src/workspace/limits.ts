export const MAX_FILE = 1024 * 1024;
export const MAX_OUT = 64 * 1024;
export function integer(n: number, min: number, max: number) {
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error("INVALID_RANGE");
  return n;
}
