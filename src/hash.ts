import { createHash } from "node:crypto";

export const sha = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
