/** Reject lossy or binary policy parsing instead of weakening a deny boundary. */
export function policyText(bytes: Buffer): string {
  try {
    // Git accepts an initial UTF-8 BOM and CRLF. Keep both available to ignore.
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
      throw new Error("POLICY_UNREADABLE");
    return text;
  } catch {
    throw new Error("POLICY_UNREADABLE");
  }
}
