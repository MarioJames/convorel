export interface ControlTarget {
  scope: string;
  role: string;
  names?: readonly string[];
  fallback?: string | null;
  url?: string;
}

export type ControlAction = "click" | "fill" | "focus";
export type RunControl = (
  action: ControlAction,
  target: ControlTarget,
  value?: string,
  beforeDispatch?: () => Promise<void>,
) => Promise<any>;

/** Scoped snapshots can carry a global ref table. Only refs actually present in
 * the scoped tree are candidates; a ref is consumed once, never persisted. */
export function controlRef(snapshot: any, target: ControlTarget): string {
  if (typeof snapshot?.snapshot !== "string" || !snapshot.refs)
    throw new Error("CONTROL_SNAPSHOT_UNRECOGNIZED");
  if (target.url && snapshot.origin !== target.url)
    throw new Error("CONTROL_PAGE_CHANGED");
  const refs = [
    ...new Set(
      Array.from(
        snapshot.snapshot.matchAll(/\bref=(e\d+)\b/g),
        (match: any) => match[1],
      ),
    ),
  ];
  const matches = refs.filter((ref) => {
    const node = snapshot.refs[ref];
    return (
      node?.role === target.role &&
      (!target.names || target.names.includes(node.name))
    );
  });
  if (matches.length > 1) throw new Error("CONTROL_AMBIGUOUS: " + target.role);
  if (matches.length === 1) return "@" + matches[0];
  if (target.fallback) return target.fallback;
  throw new Error("CONTROL_NOT_FOUND: " + target.role);
}
