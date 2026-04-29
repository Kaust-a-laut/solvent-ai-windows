/**
 * Detects whether this backend process is running as a Native Bridge sidecar
 * (spawned by nativeCopyManager with SOLVENT_SIDECAR=1) versus the primary
 * host backend.
 *
 * File-based state is naturally isolated because the sidecar lives at a
 * different location on disk than the host — process.cwd(), __dirname, and
 * PROJECT_ROOT all resolve to the sidecar's own install, so its files
 * can't overwrite the host's.
 *
 * The collision that IS real is Redis/BullMQ: both backends hit
 * redis://127.0.0.1:6379 and subscribe to identical queue names, so a job
 * enqueued by the sidecar can be picked up by the host's worker (and vice
 * versa). BullMQ's `prefix` option namespaces every Redis key a queue
 * touches — setting it per-mode gives each backend its own queue space on
 * the same Redis instance.
 */

export const isSidecar = process.env.SOLVENT_SIDECAR === '1';

/**
 * BullMQ key prefix. Default is 'bull'; sidecars use 'bull-sidecar' so
 * jobs do not leak between host and copy.
 */
export const bullMqPrefix = isSidecar ? 'bull-sidecar' : 'bull';
