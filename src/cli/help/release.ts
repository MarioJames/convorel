import { page } from "./shared.ts";

export const upgradePage = page(
  ["upgrade"],
  ["upgrade [--version TAG]"],
  "Upgrade an installed convorel runtime. A source checkout is told to update the checkout; nothing is downloaded for it.",
  [
    [
      "--version TAG",
      "Release tag to install, such as vX.Y.Z. Omit it to use the current latest release.",
    ],
  ],
  [
    "An installed upgrade checks the checksum and the executable version, switches the install link, and keeps the previous version, sessions, preferences, and skills. It does not restart a running background client and does not update skills by itself. Run skills check afterward.",
  ],
);

export const versionPage = page(
  ["version"],
  ["version [--check]", "--version"],
  "Print this build. version prints JSON. --version prints only the version number.",
  [
    [
      "--check",
      "Also ask the release server whether this build is current. It takes no value and is only valid after version.",
    ],
  ],
  [
    "The JSON includes the version, commit, runtime, architecture, and browser-controller path. --check adds the latest release and whether this build matches it.",
  ],
);
