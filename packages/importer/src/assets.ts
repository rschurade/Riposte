/**
 * Set asset pool with content-hash identity.
 *
 * Identity = sha1 of the decoded bytes; the filename is only a human label.
 * - same bytes (any name)      → one canonical file, references rewritten
 * - same name, different bytes → NEVER overwritten; newcomer stored under a
 *   hash-suffixed name and the collision is reported
 * The pool indexes existing files on open so repeated imports into the same
 * set stay deduplicated across runs.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

export interface AssetReport {
  written: string[];
  deduplicated: { name: string; canonical: string }[];
  collisions: { name: string; storedAs: string }[];
}

export class AssetPool {
  private setDir: string;
  private byHash = new Map<string, string>(); // sha1 -> rel path (posix)
  private byPath = new Map<string, string>(); // rel path -> sha1
  readonly report: AssetReport = { written: [], deduplicated: [], collisions: [] };

  private constructor(setDir: string) {
    this.setDir = setDir;
  }

  static async open(setDir: string): Promise<AssetPool> {
    const pool = new AssetPool(setDir);
    await pool.scan('assets');
    return pool;
  }

  private async scan(rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(join(this.setDir, rel), { withFileTypes: true });
    } catch {
      return; // no assets dir yet
    }
    for (const e of entries) {
      const childRel = posix.join(rel, e.name);
      if (e.isDirectory()) await this.scan(childRel);
      else {
        const hash = sha1(await readFile(join(this.setDir, childRel)));
        this.byHash.set(hash, childRel);
        this.byPath.set(childRel, hash);
      }
    }
  }

  /**
   * Store bytes under assets/<subdir>/<name>; returns the set-relative path
   * to reference (which may be an existing canonical file).
   */
  async store(bytes: Buffer, name: string, subdir = ''): Promise<string> {
    const hash = sha1(bytes);

    const canonical = this.byHash.get(hash);
    if (canonical) {
      if (posix.basename(canonical) !== name) {
        this.report.deduplicated.push({ name, canonical });
      }
      return canonical;
    }

    let rel = posix.join('assets', subdir, sanitize(name));
    if (this.byPath.has(rel)) {
      // same name, different content — never overwrite
      const suffixed = withHashSuffix(rel, hash);
      this.report.collisions.push({ name, storedAs: suffixed });
      rel = suffixed;
    }

    const full = join(this.setDir, rel);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, bytes);
    this.byHash.set(hash, rel);
    this.byPath.set(rel, hash);
    this.report.written.push(rel);
    return rel;
  }
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\s]/g, '_');
}

function withHashSuffix(rel: string, hash: string): string {
  const dot = rel.lastIndexOf('.');
  const stem = dot > rel.lastIndexOf('/') ? rel.slice(0, dot) : rel;
  const ext = dot > rel.lastIndexOf('/') ? rel.slice(dot) : '';
  return `${stem}-${hash.slice(0, 8)}${ext}`;
}

/** Decode a Loopic resource `content` field (data URI or raw base64). */
export function decodeContent(content: string): Buffer {
  const comma = content.startsWith('data:') ? content.indexOf(',') : -1;
  const raw = comma >= 0 ? content.slice(comma + 1) : content;
  // Detect non-base64 content (e.g. raw SVG XML)
  if (raw.trimStart().startsWith('<')) return Buffer.from(raw, 'utf8');
  return Buffer.from(raw, 'base64');
}
