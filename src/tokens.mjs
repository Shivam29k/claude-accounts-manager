// Token usage from Claude Code transcripts (<claude dir>/projects/**/*.jsonl), which every
// Claude Code session on this machine writes, including ones started through the Agent SDK
// (IDE extensions, T3 Code and similar). Each assistant line
// carries message.usage. Lines are read once (per-file byte offsets), de-duplicated by
// message id + request id (Claude writes one line per content block, all sharing the same
// usage), bucketed per half hour, and attributed to whichever account was live at that moment.
//
// Counted tokens = input + output + cache writes. Cache reads are kept separately: they
// are ~40x larger and mostly re-reads of the same context.
//
// Other machines' agents count their own transcripts the same way and send half-hour totals per
// model (addRemote); those are attributed to the account that machine was using at the time.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Half-hour slots, so the browser can regroup them into local hours/days in half-hour time zones such as UTC+5:30.
const SLOT = 1800_000;
const CHUNK = 1 << 20;

export const LOCAL = 'local';

export function createTokenIndex({ projectsDir, file, accountAt }) {
  let idx = { v: 4, files: {}, hours: {}, models: {}, machines: {}, seen: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.v === 4) idx = saved;
    else if (saved?.v === 3) {
      // Before machines existed everything came from this one.
      saved.machines = {};
      for (const [h, row] of Object.entries(saved.hours)) saved.machines[h] = { [LOCAL]: Object.values(row).reduce((n, [x]) => n + x, 0) };
      idx = { ...saved, v: 4 };
    }
  } catch {}
  const seen = new Set(idx.seen);
  let scanning = null;
  let ready = Object.keys(idx.files).length > 0;
  let dirty = false;

  function listJsonl(dir, out = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) listJsonl(p, out);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  function onLine(buf) {
    if (!buf.includes('"usage"') || !buf.includes('"assistant"')) return;
    let d;
    try {
      d = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    const m = d?.message;
    const u = m?.usage;
    if (d.type !== 'assistant' || !u) return;
    const key = crypto.createHash('sha1').update(`${m.id}:${d.requestId}`).digest('base64').slice(0, 14);
    if (seen.has(key)) return;
    seen.add(key);
    const ts = Date.parse(d.timestamp);
    if (!ts) return;
    const n = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const cr = u.cache_read_input_tokens || 0;
    if (!n && !cr) return;
    const h = Math.floor(ts / SLOT) * SLOT;
    const bucket = (idx.hours[h] ||= {});
    const v = (bucket[accountAt(ts)] ||= [0, 0]);
    v[0] += n;
    v[1] += cr;
    if (n) {
      const mb = (idx.machines[h] ||= {});
      mb[LOCAL] = (mb[LOCAL] || 0) + n;
    }
    if (n && m.model && m.model !== '<synthetic>') {
      const mb = (idx.models[h] ||= {});
      mb[m.model] = (mb[m.model] || 0) + n;
    }
    dirty = true;
  }

  // Reads [off, size) and returns the offset just past the last complete line.
  async function readFrom(f, off, size) {
    const fh = await fs.promises.open(f, 'r');
    try {
      let pos = off;
      let carry = Buffer.alloc(0);
      let consumed = off;
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (!bytesRead) break;
        pos += bytesRead;
        let data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
          onLine(data.subarray(start, nl));
          consumed += nl - start + 1;
          start = nl + 1;
        }
        carry = Buffer.from(data.subarray(start));
        await new Promise((r) => setImmediate(r)); // stay responsive on big files
      }
      return consumed;
    } finally {
      await fh.close();
    }
  }

  function persist() {
    if (!dirty) return;
    idx.seen = [...seen];
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
    fs.renameSync(tmp, file);
    dirty = false;
  }

  async function scanOnce() {
    const files = listJsonl(projectsDir);
    for (const f of files) {
      let st;
      try {
        st = fs.statSync(f);
      } catch {
        continue;
      }
      const rec = idx.files[f] || { off: 0 };
      if (st.size < rec.off) rec.off = 0; // rewritten: re-read; de-dup keeps totals right
      if (st.size > rec.off) {
        try {
          rec.off = await readFrom(f, rec.off, st.size);
        } catch (e) {
          console.error('token scan failed for', f, e.message);
        }
      }
      if (!idx.files[f]) dirty = true;
      idx.files[f] = rec;
    }
    for (const f of Object.keys(idx.files)) if (!files.includes(f)) delete idx.files[f];
    ready = true;
    persist();
  }

  return {
    // slots: [[slotStartMs, { model: tokens }]] from a machine's agent.
    // accountAtOn(ts): the account that machine used at ts.
    addRemote(machineId, slots, accountAtOn) {
      for (const [t, row] of slots) {
        const h = Math.floor(t / SLOT) * SLOT;
        let total = 0;
        for (const [model, n] of Object.entries(row)) {
          total += n;
          if (model && model !== '<synthetic>') {
            const mb = (idx.models[h] ||= {});
            mb[model] = (mb[model] || 0) + n;
          }
        }
        if (!total) continue;
        const v = ((idx.hours[h] ||= {})[accountAtOn(h + SLOT / 2)] ||= [0, 0]);
        v[0] += total;
        const mb = (idx.machines[h] ||= {});
        mb[machineId] = (mb[machineId] || 0) + total;
        dirty = true;
      }
      persist();
    },
    scan() {
      scanning ??= scanOnce().finally(() => (scanning = null));
      return scanning;
    },
    get ready() {
      return ready;
    },
    // Half-hour buckets from `from` on, by account, model id and machine, plus the first slot on record.
    series(from = 0) {
      const out = [];
      let first = null;
      for (const [k, v] of Object.entries(idx.hours)) {
        const t = Number(k);
        if (first === null || t < first) first = t;
        if (t < from) continue;
        const row = {};
        for (const [acc, [n]] of Object.entries(v)) if (n) row[acc] = n;
        out.push([t, row]);
      }
      out.sort((a, b) => a[0] - b[0]);
      const rows = (o) => Object.entries(o).map(([k, v]) => [Number(k), v]).filter(([t]) => t >= from).sort((a, b) => a[0] - b[0]);
      return { hours: out, models: rows(idx.models), machines: rows(idx.machines), first, ready };
    },
  };
}
