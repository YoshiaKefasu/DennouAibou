import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/**
 * Open the durable session storage at `dbPath`, creating its directory first.
 *
 * The directory is created with mode `0700` so the transcript stays owner-only. Windows ignores
 * `mode` for an existing directory, so a directory created by another tool keeps its own ACL.
 */
export async function openSessionStorage(dbPath: string): Promise<Storage> {
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  return await openNodeSqliteStorage(dbPath);
}
