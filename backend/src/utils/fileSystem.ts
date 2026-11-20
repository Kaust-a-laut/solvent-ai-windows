import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { randomUUID } from 'node:crypto';
import { logger } from './logger';
import { getRequestContext } from './requestContext';

// Global (repo) root — safety floor that no request may escape, regardless of
// per-request project scoping.
export const PROJECT_ROOT = path.resolve(__dirname, '../../../');

/**
 * Effective project root for the current request. When a chat request specifies
 * a `projectRoot` (via requestContextStore), tool operations are scoped to it.
 * Falls back to the global PROJECT_ROOT when no per-request scope is active.
 *
 * Always returns a path that is inside (or equal to) PROJECT_ROOT — the
 * controller is responsible for validating the per-request value before
 * populating the store.
 */
export const getEffectiveProjectRoot = (): string => {
  const ctx = getRequestContext();
  return ctx?.projectRoot ?? PROJECT_ROOT;
};

// Trailing separator prevents prefix attacks (e.g. /root vs /root-evil).
const withTrailingSep = (p: string) => (p.endsWith(path.sep) ? p : p + path.sep);

const normalizeForCompare = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * Resolve symlinks/junctions on the nearest existing ancestor, then reattach
 * any non-existent trailing path segments. Prevents symlink escapes for both
 * existing paths and not-yet-created write targets.
 */
export function realPathWithMissingTailSync(target: string): string {
  const resolved = path.resolve(target);
  let current = resolved;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fsSync.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

const isInsideNormalized = (candidate: string, root: string): boolean => {
  const normCandidate = normalizeForCompare(candidate);
  const normRoot = normalizeForCompare(root);
  return normCandidate === normRoot || normCandidate.startsWith(withTrailingSep(normRoot));
};

/**
 * Check whether an already-resolved absolute path is inside the effective
 * project root (per-request scope if set, otherwise the global repo root)
 * AND inside the global repo root — both boundaries are enforced, same as
 * validatePath. Also resolves symlinks/junctions and handles Windows casing.
 */
export const isPathWithinRoot = (absPath: string): boolean => {
  const effectiveRoot = realPathWithMissingTailSync(getEffectiveProjectRoot());
  const globalRoot = realPathWithMissingTailSync(PROJECT_ROOT);
  const realTarget = realPathWithMissingTailSync(absPath);
  if (!isInsideNormalized(realTarget, effectiveRoot)) return false;
  if (!isInsideNormalized(realTarget, globalRoot)) return false;
  return true;
};

/**
 * Validate a path is inside the effective project root (per-request scope if
 * set, otherwise the global repo root). Both boundaries are enforced — a
 * per-request path may not escape into a sibling project even if the global
 * repo would have allowed it.
 */
export const validatePath = (targetPath: string) => {
  const effectiveRoot = getEffectiveProjectRoot();
  const normalized = path.resolve(effectiveRoot, targetPath);
  if (!isPathWithinRoot(normalized)) {
    throw new Error(`SECURITY ALERT: Path escape detected: ${targetPath}`);
  }
  return normalized;
};

export class AtomicFileSystem {
  /**
   * Writes data to a file atomically by first writing to a temp file
   * and then renaming it. This prevents data corruption on crashes.
   */
  static async writeJson(filePath: string, data: unknown) {
    const tempPath = `${filePath}.tmp.${Date.now()}.${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
      await fs.rename(tempPath, filePath);
    } catch (error) {
      logger.error(`[AtomicFS] Failed to write JSON to ${filePath}`, error);
      try { await fs.unlink(tempPath); } catch { logger.debug('[AtomicFS] Temp file cleanup failed', { path: tempPath }); }
      throw error;
    }
  }

  static async writeFile(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp.${Date.now()}.${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, content);
      await fs.rename(tempPath, filePath);
    } catch (error) {
      logger.error(`[AtomicFS] Failed to write file to ${filePath}`, error);
      try { await fs.unlink(tempPath); } catch { logger.debug('[AtomicFS] Temp file cleanup failed', { path: tempPath }); }
      throw error;
    }
  }
}
