import fs from 'fs/promises';
import path from 'path';

export class PathSecurityError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'PathSecurityError';
  }
}

const withSeparator = (value: string): string =>
  value.endsWith(path.sep) ? value : value + path.sep;

export function isPathInside(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(withSeparator(resolvedRoot));
}

// Walk up to the nearest existing ancestor, realpath that, then reattach the
// missing tail. Without this, fs.realpath fails on a non-existent target and
// callers fall back to the lexical path — which lets `root/symlink/new.txt`
// pass containment even when `root/symlink` points outside the root.
async function realPathWithMissingTail(target: string): Promise<string> {
  const resolvedTarget = path.resolve(target);
  let current = resolvedTarget;
  const tail: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return resolvedTarget;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export async function resolveSecurePath(
  userPath: string,
  root: string,
  permittedRoots: string[],
): Promise<string> {
  if (typeof userPath !== 'string' || userPath.trim().length === 0) {
    throw new PathSecurityError('Invalid path');
  }

  const normalizedRoot = path.resolve(root);
  const resolvedPath = path.resolve(normalizedRoot, userPath);
  if (!isPathInside(resolvedPath, normalizedRoot)) {
    throw new PathSecurityError();
  }

  const realPath = await realPathWithMissingTail(resolvedPath);
  const allowed = permittedRoots.map(p => path.resolve(p)).some(permittedRoot =>
    isPathInside(realPath, permittedRoot)
  );

  if (!allowed) {
    throw new PathSecurityError();
  }

  return realPath;
}

export async function resolveSecureChildPath(
  root: string,
  childPath: string | undefined,
  permittedRoots: string[],
): Promise<string> {
  if (!childPath) return path.resolve(root);
  return resolveSecurePath(childPath, root, permittedRoots);
}
