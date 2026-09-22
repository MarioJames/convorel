import { sha as hash } from "../hash.ts";
export { hash };
export const MAX_OUTPUT = 56 * 1024;
export const TEXT_BUDGET = 20 * 1024;
export const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
export const decode = (b: Buffer) => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    throw new Error("GIT_INVALID_UTF8");
  }
};
export const textBlob = (b: Buffer) => {
  if (b.includes(0)) throw new Error("BINARY_FILE");
  const s = decode(b);
  if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s))
    throw new Error("BINARY_FILE");
  return s;
};
export const finish = <T>(value: T): T => {
  if (bytes(value) > MAX_OUTPUT) throw new Error("GIT_HISTORY_RESPONSE_LIMIT");
  return value;
};
