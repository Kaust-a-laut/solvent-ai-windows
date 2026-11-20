import fs from 'fs/promises';
import path from 'path';
import { createHash, randomBytes } from 'node:crypto';
import { logger } from './logger';
import { AtomicFileSystem } from './fileSystem';

export class BackupManager {
  private sourcePath: string;
  private backupDir: string;
  private maxBackups: number;

  constructor(sourcePath: string, backupDir: string, maxBackups: number = 5) {
    this.sourcePath = sourcePath;
    this.backupDir = backupDir;
    this.maxBackups = maxBackups;
  }

  async createBackup(): Promise<string | null> {
    try {
      await fs.mkdir(this.backupDir, { recursive: true });

      const content = await fs.readFile(this.sourcePath, 'utf-8');
      const data = JSON.parse(content);
      // Millisecond timestamp + random suffix: two backups in the same second
      // used to overwrite each other. Still sorts chronologically by name.
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `backup_${timestamp}_${randomBytes(3).toString('hex')}.json`;
      const backupPath = path.join(this.backupDir, backupFileName);

      // Compute checksum on canonical JSON string (matches validation)
      const dataString = JSON.stringify(data);
      const checksum = this.computeChecksum(dataString);

      const backupData = {
        _checksum: checksum,
        _createdAt: new Date().toISOString(),
        data: data
      };

      await AtomicFileSystem.writeJson(backupPath, backupData);
      logger.info(`[BackupManager] Created backup: ${backupFileName}`);

      await this.rotateBackups();
      return backupPath;
    } catch (error) {
      logger.error('[BackupManager] Failed to create backup', error);
      return null;
    }
  }

  private async rotateBackups(): Promise<void> {
    try {
      const files = await fs.readdir(this.backupDir);
      const backupFiles = files
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .sort()
        .reverse();

      if (backupFiles.length > this.maxBackups) {
        const toDelete = backupFiles.slice(this.maxBackups);
        for (const file of toDelete) {
          await fs.unlink(path.join(this.backupDir, file));
          logger.info(`[BackupManager] Rotated out old backup: ${file}`);
        }
      }
    } catch (error) {
      logger.error('[BackupManager] Failed to rotate backups', error);
    }
  }

  async validateBackup(backupPath: string): Promise<boolean> {
    return (await this.readValidBackup(backupPath)) !== undefined;
  }

  /** Read + checksum-verify a backup once; returns its data, or undefined if invalid. */
  private async readValidBackup(backupPath: string): Promise<unknown | undefined> {
    try {
      const content = await fs.readFile(backupPath, 'utf-8');
      const parsed = JSON.parse(content) as { _checksum?: string; data?: unknown };

      if (!parsed._checksum || parsed.data === undefined) {
        return undefined;
      }

      const recomputed = this.computeChecksum(JSON.stringify(parsed.data));
      return recomputed === parsed._checksum ? parsed.data : undefined;
    } catch (error) {
      logger.error(`[BackupManager] Backup validation failed: ${backupPath}`, error);
      return undefined;
    }
  }

  async restoreFromBackup(): Promise<boolean> {
    try {
      const files = await fs.readdir(this.backupDir);
      const backupFiles = files
        .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
        .sort()
        .reverse();

      for (const file of backupFiles) {
        const backupPath = path.join(this.backupDir, file);
        // Validate and restore from the same read (the old code re-read the
        // file after validating it), and restore atomically.
        const data = await this.readValidBackup(backupPath);

        if (data !== undefined) {
          await AtomicFileSystem.writeJson(this.sourcePath, data);
          logger.info(`[BackupManager] Restored from backup: ${file}`);
          return true;
        } else {
          logger.warn(`[BackupManager] Skipping invalid backup: ${file}`);
        }
      }

      logger.error('[BackupManager] No valid backups found for restoration');
      return false;
    } catch (error) {
      logger.error('[BackupManager] Restore failed', error);
      return false;
    }
  }

  private computeChecksum(data: string): string {
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
  }
}
