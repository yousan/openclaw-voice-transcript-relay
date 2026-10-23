import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFERRED = "/tmp/openclaw";

/**
 * Where the Gateway writes its rolling log, decided the way OpenClaw decides
 * (resolveSecureTempRoot in @openclaw/fs-safe): /tmp/openclaw when it is a real
 * directory owned by this user, else <tmpdir>/openclaw-<uid>. Another user's
 * /tmp/openclaw exists but is never ours.
 */
export function defaultLogDir({
  preferred = PREFERRED,
  platform = process.platform,
  getuid = typeof process.getuid === "function" ? () => process.getuid() : () => undefined,
  tmpdir = os.tmpdir,
  lstat = fs.lstatSync,
  access = fs.accessSync,
} = {}) {
  const uid = getuid();
  const fallback = path.join(tmpdir(), uid === undefined ? "openclaw" : `openclaw-${uid}`);
  if (platform === "win32") return fallback;
  if (uid === undefined) return preferred;
  let st;
  try {
    st = lstat(preferred);
  } catch (e) {
    if (e?.code !== "ENOENT") return fallback;
    // Missing: OpenClaw creates it when it can.
    return canUse(access, path.dirname(preferred)) ? preferred : fallback;
  }
  // A group/other-writable dir we own gets its mode tightened by OpenClaw and is
  // still used, so only ownership and type decide here.
  if (!st.isDirectory() || st.isSymbolicLink() || Number(st.uid) !== uid) return fallback;
  return canUse(access, preferred) ? preferred : fallback;
}

function canUse(access, dir) {
  try {
    access(dir, fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
