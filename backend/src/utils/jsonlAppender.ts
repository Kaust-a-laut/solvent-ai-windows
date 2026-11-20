import { appendFile, stat, rename, unlink } from 'fs/promises';
import { logger } from './logger';

export interface JsonlAppenderOptions {
  /** Rotate once the live file exceeds this many bytes. */
  maxBytes: number;
  /** How many rotated generations to keep (`file.1.jsonl` … `file.N.jsonl`). */
  keep: number;
}

/** `foo.jsonl` → `foo.1.jsonl`; files without the extension get `.1` appended. */
export function rotatedPath(file: string, generation: number): string {
  return file.endsWith('.jsonl')
    ? `${file.slice(0, -'.jsonl'.length)}.${generation}.jsonl`
    : `${file}.${generation}`;
}

/**
 * Append-only JSONL writer with size-based rotation.
 *
 * Every append and rotation runs on one promise queue, so concurrent callers
 * can't interleave a rename with an append (the old per-call
 * stat→rename→append raced: two writers could both rotate, or append to a
 * file that had just been renamed away).
 */
export class JsonlAppender {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string, private readonly opts: JsonlAppenderOptions) {}

  get path(): string {
    return this.file;
  }

  /** Append one already-serialized line (a trailing newline is added). Never rejects. */
  append(line: string): Promise<void> {
    const run = this.queue.then(async () => {
      await this.rotateIfNeeded();
      await appendFile(this.file, line.endsWith('\n') ? line : `${line}\n`, 'utf-8');
    });
    this.queue = run.catch((err) => {
      logger.warn(`[JsonlAppender] Failed to append to ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.queue;
  }

  private async rotateIfNeeded(): Promise<void> {
    let size: number;
    try {
      ({ size } = await stat(this.file));
    } catch {
      return; // file doesn't exist yet
    }
    if (size <= this.opts.maxBytes) return;
    // Oldest generation is dropped, each other generation shifts up by one.
    try { await unlink(rotatedPath(this.file, this.opts.keep)); } catch { /* may not exist */ }
    for (let gen = this.opts.keep - 1; gen >= 1; gen--) {
      try { await rename(rotatedPath(this.file, gen), rotatedPath(this.file, gen + 1)); } catch { /* may not exist */ }
    }
    await rename(this.file, rotatedPath(this.file, 1));
  }
}

export const DEFAULT_JSONL_ROTATION: JsonlAppenderOptions = { maxBytes: 20 * 1024 * 1024, keep: 2 };
