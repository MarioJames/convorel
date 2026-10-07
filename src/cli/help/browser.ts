import { page } from "./shared.ts";

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
      "Start the managed Chrome when its endpoint is down, open ChatGPT if no ChatGPT tab exists, and wait until you are signed in.",
      [
        [
          "--login-timeout SECONDS",
          "How long to wait for the ChatGPT sign-in, 1 to 3600. Default 600.",
        ],
      ],
      [
        "A binding to your own Chrome (init --cdp) is refused; start that browser yourself.",
      ],
    ),
  ],
);
