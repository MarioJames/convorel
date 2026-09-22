// Leave room for full paths, provenance and the MCP structured response envelope.
export const CONTENT_BUDGET = 56 * 1024;

export function range(n: number, min: number, max: number) {
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error("INVALID_RANGE");
  return n;
}

export function textPage(buf: Buffer, startLine = 1, maxLines = 400) {
  range(startLine, 1, 10_000_000);
  range(maxLines, 1, 1000);
  if (buf.includes(0)) throw new Error("BINARY_FILE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buf,
    );
  } catch {
    throw new Error("INVALID_UTF8");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(startLine - 1, startLine - 1 + maxLines)) {
    const size = Buffer.byteLength(JSON.stringify(line)) + 2;
    if (bytes + size > CONTENT_BUDGET) {
      if (!out.length) throw new Error("LINE_TOO_LONG");
      break;
    }
    out.push(line);
    bytes += size;
  }
  const endLine = startLine + out.length - 1;
  const truncated = endLine < lines.length;
  return {
    content: out.join("\n"),
    startLine,
    endLine,
    totalLines: lines.length,
    truncated,
    nextStartLine: truncated ? endLine + 1 : null,
  };
}

export function pathMatcher(pattern: string) {
  if (
    !pattern ||
    pattern.length > 200 ||
    pattern.includes("\0") ||
    pattern.includes("\\") ||
    pattern.startsWith("/") ||
    pattern.split("/").includes("..")
  )
    throw new Error("INVALID_PATTERN");
  const glob = new Bun.Glob(pattern);
  return (path: string) =>
    glob.match(pattern.includes("/") ? path : path.split("/").at(-1)!);
}

export function textChunk(
  text: string,
  offset: number,
  budget = CONTENT_BUDGET,
) {
  range(offset, 0, text.length);
  if (budget < 2) throw new Error("RESPONSE_TOO_LARGE");
  if (
    offset > 0 &&
    /[\uDC00-\uDFFF]/.test(text[offset] || "") &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!)
  )
    throw new Error("INVALID_OFFSET");
  let low = offset,
    high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(text.slice(offset, mid))) <= budget)
      low = mid;
    else high = mid - 1;
  }
  if (low < text.length && /[\uD800-\uDBFF]/.test(text[low - 1] || "")) low--;
  if (low === offset && low < text.length)
    throw new Error("RESPONSE_TOO_LARGE");
  return {
    text: text.slice(offset, low),
    nextOffset: low < text.length ? low : null,
  };
}
