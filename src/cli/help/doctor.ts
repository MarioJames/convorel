import { page } from "./shared.ts";

export const doctorPage = page(
  ["doctor"],
  ["doctor", "doctor --local true"],
  "Check the local tools this state directory depends on. Without --local, the command connects to Chrome and checks the local MCP server. It does not prove that ChatGPT can call those tools.",
  [
    [
      "--local true",
      "Check only the task documents and the archive. The value must be true. Any other value is an error and does not fall through to the browser check.",
    ],
  ],
  [
    "The browser doctor exits 1 when Chrome or the local MCP check failed. doctor --local exits 1 when the archive fails its own integrity check, and 2 when the local record is readable but incomplete.",
  ],
);
