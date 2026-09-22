import type { Database } from "bun:sqlite";

/**
 * The narrow capability handle the split modules work through: one live connection
 * plus the store's transaction and permission capabilities. `Archive` owns the
 * connection and builds this handle once in its constructor, so a publish keeps its
 * content versions and selection pointers on the same connection in one transaction;
 * modules never open a connection of their own and the store gains no public API.
 */
export interface ArchiveStore {
  readonly db: Database;
  readonly path: string;
  readonly writable: boolean;
  readonly one: (sql: string, ...args: any[]) => any;
  readonly all: (sql: string, ...args: any[]) => any[];
  /** BEGIN IMMEDIATE wrapper: the store's single transaction owner. */
  readonly writeTransaction: (work: () => void) => void;
  readonly harden: () => void;
}
