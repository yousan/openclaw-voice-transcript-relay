// Follow OpenClaw's rolling gateway log: one file per local day, rotated by
// size (the active file becomes <name>.1.log and a fresh one is created).
// Keeps the open descriptor so lines written just before a rotation or a
// date change are still read to the end before switching.

import fs from "node:fs";
import path from "node:path";

export function logFileFor(dir, profile, date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const name = profile ? `openclaw-${profile}-${y}-${m}-${d}.log` : `openclaw-${y}-${m}-${d}.log`;
  return path.join(dir, name);
}

export class LogFollower {
  /**
   * @param {object} o
   * @param {() => string} o.resolvePath  path of the file that is active now
   * @param {(line: string, pos: {file: string, ino: number, offset: number}) => void} o.onLine
   * @param {{file?: string, ino?: number, offset?: number}} [o.resume]
   * @param {boolean} [o.fromStart]  read the current file from the beginning
   */
  constructor({ resolvePath, onLine, resume, fromStart = false, onSwitch = () => {} }) {
    this.resolvePath = resolvePath;
    this.onLine = onLine;
    this.onSwitch = onSwitch;
    this.fd = null;
    this.file = null;
    this.ino = 0;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.resume = resume;
    this.fromStart = fromStart;
  }

  /** Read whatever is new. Call repeatedly (e.g. every 500 ms). */
  poll() {
    const want = this.resolvePath();
    if (this.fd === null) {
      this.openInitial(want);
      if (this.fd === null) return;
    }
    this.drain();
    const st = statOrNull(want);
    if (!st) return; // today's file not created yet
    if (want !== this.file || st.ino !== this.ino) {
      this.drain(); // last lines of the old file
      this.switchTo(want, st, 0);
      this.drain();
    }
  }

  openInitial(want) {
    const r = this.resume;
    if (r?.file) {
      const st = statOrNull(r.file);
      if (st && st.ino === r.ino && st.size >= (r.offset ?? 0)) {
        this.switchTo(r.file, st, r.offset ?? 0);
        return;
      }
      // Resumed file was rotated away; look for it among the archives.
      const archived = findByInode(r.file, r.ino);
      if (archived) {
        const ast = statOrNull(archived);
        if (ast && ast.size >= (r.offset ?? 0)) {
          this.switchTo(archived, ast, r.offset ?? 0, r.file);
          return;
        }
      }
    }
    const st = statOrNull(want);
    if (!st) return;
    this.switchTo(want, st, this.fromStart ? 0 : st.size);
  }

  switchTo(file, st, offset, logicalName = file) {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = fs.openSync(file, "r");
    this.file = logicalName;
    this.ino = st.ino;
    this.offset = offset;
    this.partial = Buffer.alloc(0);
    this.onSwitch({ file: logicalName, ino: st.ino, offset });
  }

  drain() {
    if (this.fd === null) return;
    const buf = Buffer.alloc(256 * 1024);
    for (;;) {
      const n = fs.readSync(this.fd, buf, 0, buf.length, this.offset);
      if (n <= 0) break;
      // `data` starts at byte `base` of the file (partial = unterminated tail).
      const base = this.offset - this.partial.length;
      const data = Buffer.concat([this.partial, buf.subarray(0, n)]);
      this.offset += n;
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = data.subarray(start, nl).toString("utf8");
        start = nl + 1;
        if (line) this.onLine(line, { file: this.file, ino: this.ino, offset: base + start });
      }
      this.partial = Buffer.from(data.subarray(start));
    }
  }

  close() {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }
}

function statOrNull(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// OpenClaw names archives openclaw-<...>-YYYY-MM-DD.1.log; also accept .log.1.
function findByInode(file, ino) {
  for (let i = 1; i <= 5; i++) {
    for (const candidate of [file.replace(/\.log$/, `.${i}.log`), `${file}.${i}`]) {
      const st = statOrNull(candidate);
      if (st && st.ino === ino) return candidate;
    }
  }
  return null;
}
