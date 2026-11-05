// Copy-on-write file clone. Separate from instance creation so tests on hosts
// without a cloning filesystem can replace this one operation.

import { constants, copyFileSync } from "node:fs";

/** Clone `source` to `destination`, failing rather than falling back to a full copy. */
export function cloneFile(source: string, destination: string): void {
  copyFileSync(source, destination, constants.COPYFILE_FICLONE_FORCE);
}
