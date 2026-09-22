import { configRules, page } from "./shared.ts";

const config = [
  page(
    ["config", "list"],
    ["config list"],
    "Show every preference key, whether it is set, and the preferences file path. A secret is reported as set or unset, not printed.",
    [],
    [configRules],
  ),
  page(
    ["config", "get"],
    ["config get KEY"],
    "Show one preference. tunnel.apiKey is reported as set or unset and is not printed.",
    [],
    [configRules, "KEY is positional. An unknown key is an error."],
  ),
  page(
    ["config", "set"],
    ["config set KEY VALUE"],
    "Write one preference. The value is checked before it is saved. This does not change tasks that already exist.",
    [],
    [
      configRules,
      "VALUE is positional and is not an option even when it starts with a dash. Use config unset KEY to remove a value.",
    ],
  ),
  page(
    ["config", "unset"],
    ["config unset KEY"],
    "Remove one preference. The next read treats it as unset.",
    [],
    [configRules],
  ),
  page(
    ["config", "path"],
    ["config path"],
    "Print the preferences directory and file. This does not create them.",
  ),
];

export const configPage = page(
  ["config"],
  ["config <command>"],
  "Read and write the preferences file. Preferences are not taken from the environment.",
  [],
  [configRules],
  config,
);
