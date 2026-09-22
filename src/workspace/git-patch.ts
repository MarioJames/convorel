import { decode } from "./git-output.ts";

export function selectGitPatch(
  combined: Buffer,
  selected: {
    path: string;
    oldPath: string | null;
    oldOid: string;
    newOid: string;
    status: string;
  },
): Buffer {
  // Literal pathspecs still expand a former file into a new directory. Pair
  // the NUL-delimited raw inventory with patch blocks and return only the
  // exact approved change, never its potentially forbidden descendants.
  const separator = combined.indexOf(Buffer.from([0, 0]));
  if (separator < 0) throw new Error("GIT_INVALID_PATCH");
  const rawRows = decode(combined.subarray(0, separator)).split("\0");
  let selectedIndex = -1,
    rowCount = 0;
  for (let i = 0; i < rawRows.length; ) {
    const meta = rawRows[i++].match(
      /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRTC])\d*$/,
    );
    if (!meta) throw new Error("GIT_INVALID_PATCH");
    const first = rawRows[i++],
      renamed = meta[5] === "R" || meta[5] === "C",
      path = renamed ? rawRows[i++] : first;
    if (!path) throw new Error("GIT_INVALID_PATCH");
    if (
      path === selected.path &&
      (renamed ? first : null) === selected.oldPath &&
      meta[3] === selected.oldOid &&
      meta[4] === selected.newOid &&
      meta[5] === selected.status
    )
      selectedIndex = rowCount;
    rowCount++;
  }
  const patches = combined.subarray(separator + 2),
    starts = [0];
  if (!patches.subarray(0, 11).equals(Buffer.from("diff --git ")))
    throw new Error("GIT_INVALID_PATCH");
  for (let p = 0; (p = patches.indexOf("\ndiff --git ", p)) !== -1; p++)
    starts.push(p + 1);
  if (selectedIndex < 0 || starts.length !== rowCount)
    throw new Error("GIT_PATCH_SELECTION_CHANGED");
  return patches.subarray(
    starts[selectedIndex],
    starts[selectedIndex + 1] ?? patches.length,
  );
}
