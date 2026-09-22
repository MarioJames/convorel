import { page } from "./shared.ts";

const skills = [
  page(
    ["skills", "install"],
    [
      "skills install --agent codex|claude-code|codex,claude-code [--scope user|project] [--cwd PATH]",
      "skills install --dir PATH",
    ],
    "Copy the bundled chatgpt-review skill into an Agent directory or a chosen directory. This does not install the convorel runtime and does not require init.",
    [
      [
        "--agent LIST",
        "codex, claude-code, or both comma-separated. Cannot be combined with --dir.",
      ],
      [
        "--scope user|project",
        "user is the default. project installs under --cwd, or the current directory.",
      ],
      ["--cwd PATH", "Project directory used when --scope is project."],
      [
        "--dir PATH",
        "Install the skill directory itself at PATH/chatgpt-review. Refuses --agent, --scope, and --cwd.",
      ],
    ],
    [
      "An existing skill directory or link is left in place. Nothing is overwritten.",
    ],
  ),
  page(
    ["skills", "check"],
    [
      "skills check --agent codex|claude-code|codex,claude-code [--scope user|project] [--cwd PATH] [--baseline-dir OLD_SKILL]",
      "skills check --dir PATH [--baseline-dir OLD_SKILL]",
    ],
    "Compare an installed skill with the bundled skill. The command only reads; it does not create config, state, or an install directory.",
    [
      [
        "--agent, --scope, --cwd, --dir",
        "Same targets as install. --dir cannot be combined with --agent, --scope, or --cwd.",
      ],
      [
        "--baseline-dir PATH",
        "Trusted previous bundled skill directory. Use it only for an install that has no manifest and does not already match the current bundle.",
      ],
    ],
    [
      "Exit 0 when status is current. Exit 2 for update-available, conflict, unmanaged, or missing. Exit 1 when the arguments or the operation fail.",
      "current means the recorded baseline matches this bundle. Local edits can still be present.",
    ],
  ),
  page(
    ["skills", "update"],
    [
      "skills update --agent codex|claude-code|codex,claude-code [--scope user|project] [--cwd PATH] [--baseline-dir OLD_SKILL]",
      "skills update --dir PATH [--baseline-dir OLD_SKILL]",
    ],
    "Bring an installed skill up to the bundled files. Local-only edits stay. A file changed both locally and in the bundle stops the whole update.",
    [
      [
        "--agent, --scope, --cwd, --dir, --baseline-dir",
        "Same as skills check. --baseline-dir is not a way to force an overwrite.",
      ],
    ],
    [
      "Exit 0 when the skill was updated or is already current. Exit 2 when the update is refused because of a conflict, a missing install, or a missing baseline. Exit 1 when the arguments or the operation fail.",
      "There is no force flag. A crashed switch leaves .chatgpt-review.convorel-lock beside the target; later commands stop until that lock is recovered.",
    ],
  ),
];

export const skillsPage = page(
  ["skills"],
  ["skills <command>"],
  "Install and update the bundled chatgpt-review skill.",
  [],
  [],
  skills,
);
