import { page } from "./shared.ts";

export const loginPage = page(
  ["login"],
  ["login [--login-timeout SECONDS]"],
  "Start the managed Chrome when its endpoint is down, open ChatGPT if no ChatGPT tab exists, and wait until you are signed in.",
  [
    [
      "--login-timeout SECONDS",
      "How long to wait for the ChatGPT sign-in, 1 to 3600. Default 600.",
    ],
  ],
  [
    "Uses the same sign-in flow as browser start. A binding to your own Chrome (init --cdp) is refused; start that browser yourself.",
    "profile reports the effective browser.userDataDir preference, saved profile, or default chrome/ directory. A different profile on the same CDP port is refused without stopping it. Stop Chrome before moving profile data yourself.",
    "A headless browser that is not signed in opens a window for sign-in, then returns to headless when preferred. An existing headed window stays open. This command does not start the tunnel service.",
  ],
);

export const browserPage = page(
  ["browser"],
  ["browser start [--login-timeout SECONDS]"],
  "Manage the Chrome profile that init --browser managed created.",
  undefined,
  undefined,
  [
    page(
      ["browser", "start"],
      ["browser start [--login-timeout SECONDS]"],
      loginPage.summary,
      loginPage.options,
      loginPage.notes,
    ),
  ],
);
