import fs from 'node:fs';
import crypto from 'node:crypto';

export const now = () => Date.now();

export const b64url = (buf) => buf.toString('base64url');

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Write to a temp file in the same directory, then rename, so readers never see a half-written file.
export function writeJsonAtomic(file, obj, mode = 0o600) {
  const tmp = `${file}.cam-tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// Serialises async work: lock(fn) runs fn after everything queued before it.
export function createLock() {
  let tail = Promise.resolve();
  const lock = (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
  lock.idle = () => tail;
  return lock;
}

// An error meant for the person using the app; `data` is passed to the browser with it.
export class AppError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.data = data;
  }
}
