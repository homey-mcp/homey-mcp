import fs from "fs";
import path from "path";

export interface LocalCache {
  address: string;
  token: string;
}

/** Read the LAN session cache. A corrupt or incomplete file is deleted, so the
 *  next write creates it fresh instead of overwriting it in place with
 *  whatever mode it had. */
export function readCacheFile(file: string): LocalCache | null {
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof data?.address === "string" && typeof data?.token === "string" && data.address && data.token) {
      return { address: data.address, token: data.token };
    }
  } catch { /* corrupt: fall through and delete */ }
  try { fs.unlinkSync(file); } catch { /* already gone */ }
  return null;
}

/** Write the cache owner-only: directory 0700, file 0600. The file is written
 *  to a temp file and renamed into place, and both modes are set explicitly,
 *  because `writeFileSync`'s `mode` only applies when it creates the file. */
export function writeCacheFile(file: string, data: LocalCache): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  // O_EXCL: never follow or truncate a file or symlink already at the temp
  // path. A leftover from a crashed run is removed and the open retried once.
  let fd: number;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
  } catch (e: any) {
    if (e?.code !== "EEXIST") throw e;
    fs.unlinkSync(tmp);
    fd = fs.openSync(tmp, "wx", 0o600);
  }
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
