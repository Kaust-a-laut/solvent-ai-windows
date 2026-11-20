import path from 'path';

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'settings.json',
  'credentials.json',
  'service-account.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

const SENSITIVE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
]);

const INDEX_EXCLUDED_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
]);

/**
 * Returns true if the path refers to a secrets/credentials/config file that
 * must never be embedded into vector memory, logged in plaintext, or sent to
 * sub-agents without redaction.
 */
export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const base = (segments[segments.length - 1] ?? '').toLowerCase();

  if (!base) return false;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  if (base.startsWith('.solvent_')) return true;
  if (base.startsWith('id_rsa') || base.startsWith('id_ed25519') || base.startsWith('id_ecdsa')) return true;
  if (/secret|credential|private[_-]?key|api[_-]?key/i.test(base) && /\.(json|ya?ml|toml|ini|txt|env|cfg|conf)$/i.test(base)) {
    return true;
  }

  const ext = path.extname(base).toLowerCase();
  if (SENSITIVE_EXTENSIONS.has(ext)) return true;

  // Any file inside internal .solvent_* directories or .ssh/.aws/.gnupg
  for (const seg of segments.slice(0, -1)) {
    const lower = seg.toLowerCase();
    if (lower.startsWith('.solvent_') || lower === '.ssh' || lower === '.aws' || lower === '.gnupg') {
      return true;
    }
  }

  return false;
}

/**
 * Returns true if a file or directory should be skipped during project/codebase indexing.
 */
export function isExcludedFromIndex(filePath: string): boolean {
  if (isSensitivePath(filePath)) return true;
  const base = path.basename(filePath).toLowerCase();
  if (INDEX_EXCLUDED_BASENAMES.has(base)) return true;
  return false;
}
