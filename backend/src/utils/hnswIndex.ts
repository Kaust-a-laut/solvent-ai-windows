import { HierarchicalNSW } from 'hnswlib-node';
import fs from 'fs/promises';
import { logger } from './logger';
import { AtomicFileSystem } from './fileSystem';

export interface SearchResult {
  id: string;
  distance: number;
}

export class HNSWIndex {
  private index: HierarchicalNSW;
  private dimension: number;
  private maxElements: number;
  private idToLabel: Map<string, number> = new Map();
  private labelToId: Map<number, string> = new Map();
  private deletedLabels: Set<number> = new Set();
  private nextLabel: number = 0;

  constructor(dimension: number, maxElements: number) {
    this.dimension = dimension;
    this.maxElements = Math.max(1, maxElements);
    this.index = new HierarchicalNSW('cosine', dimension);
    // allowReplaceDeleted = true so deleted slots can be reused natively by hnswlib
    this.index.initIndex(this.maxElements, 16, 200, 100, true);
  }

  add(id: string, vector: number[]): void {
    if (!Array.isArray(vector) || vector.length !== this.dimension) {
      logger.error(`[HNSWIndex] Skipping point ${id}: expected vector length ${this.dimension}, got ${vector?.length}`);
      return;
    }

    if (this.idToLabel.has(id)) {
      this.markDeleted(id);
    }

    const label = this.nextLabel;

    try {
      // Auto-resize before adding if active + undeleted count hits capacity
      const currentCount = this.index.getCurrentCount();
      if (currentCount >= this.maxElements || label >= this.maxElements) {
        const newMax = Math.max(this.maxElements + 1, Math.ceil(Math.max(this.maxElements, label + 1) * 1.5));
        this.index.resizeIndex(newMax);
        logger.info(`[HNSWIndex] Auto-resized index from ${this.maxElements} to ${newMax} elements`);
        this.maxElements = newMax;
      }

      this.index.addPoint(vector, label, true);
      // Commit label mappings only after native addPoint succeeds
      this.nextLabel = label + 1;
      this.idToLabel.set(id, label);
      this.labelToId.set(label, id);
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.error(`[HNSWIndex] Failed to add point ${id}. Vector length: ${vector.length}. Max elements: ${this.maxElements}. Error: ${err.message}`, e);
    }
  }

  search(query: number[], k: number): SearchResult[] {
    const activeCount = this.idToLabel.size;
    if (activeCount === 0 || k <= 0) return [];
    if (!Array.isArray(query) || query.length !== this.dimension) return [];

    const actualK = Math.min(k, activeCount);

    try {
      const result = this.index.searchKnn(query, actualK);
      const neighbors = result.neighbors;
      const distances = result.distances;

      const results: SearchResult[] = [];
      for (let i = 0; i < neighbors.length && results.length < k; i++) {
        const label = neighbors[i]!;
        if (!this.deletedLabels.has(label)) {
          const id = this.labelToId.get(label);
          if (id) {
            results.push({ id, distance: distances[i] ?? Infinity });
          }
        }
      }
      return results;
    } catch (e) {
      logger.error('[HNSWIndex] Search failed', e);
      return [];
    }
  }

  markDeleted(id: string): void {
    const label = this.idToLabel.get(id);
    if (label !== undefined) {
      try {
        this.index.markDelete(label);
      } catch (e) {
        logger.debug(`[HNSWIndex] markDelete(${label}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.deletedLabels.add(label);
      this.idToLabel.delete(id);
      this.labelToId.delete(label);
    }
  }

  size(): number {
    return this.idToLabel.size;
  }

  async save(filePath: string): Promise<void> {
    try {
      await this.index.writeIndex(filePath);

      const metadata = {
        idToLabel: Array.from(this.idToLabel.entries()),
        labelToId: Array.from(this.labelToId.entries()),
        deletedLabels: Array.from(this.deletedLabels),
        nextLabel: this.nextLabel,
      };
      await AtomicFileSystem.writeJson(`${filePath}.meta.json`, metadata);
      logger.info(`[HNSWIndex] Saved index to ${filePath}`);
    } catch (e) {
      logger.error('[HNSWIndex] Failed to save index', e);
      throw e;
    }
  }

  async load(filePath: string): Promise<void> {
    try {
      // Read and validate metadata BEFORE swapping this.index so failures never desync state
      const metaContent = await fs.readFile(`${filePath}.meta.json`, 'utf-8');
      const metadata = JSON.parse(metaContent) as {
        idToLabel?: Array<[string, number]>;
        labelToId?: Array<[number, string]>;
        deletedLabels?: number[];
        nextLabel?: number;
      };
      if (
        !metadata ||
        !Array.isArray(metadata.idToLabel) ||
        !Array.isArray(metadata.labelToId) ||
        !Array.isArray(metadata.deletedLabels) ||
        typeof metadata.nextLabel !== 'number'
      ) {
        throw new Error('Invalid HNSW metadata file format');
      }

      const newIndex = new HierarchicalNSW('cosine', this.dimension);
      await newIndex.readIndex(filePath, true);

      // Commit atomically only after both index and metadata succeeded
      this.index = newIndex;
      this.idToLabel = new Map(metadata.idToLabel);
      this.labelToId = new Map(metadata.labelToId);
      this.deletedLabels = new Set(metadata.deletedLabels);
      this.nextLabel = metadata.nextLabel;
      // Always sync maxElements unconditionally to the loaded index's actual capacity
      this.maxElements = this.index.getMaxElements();

      logger.info(`[HNSWIndex] Loaded index from ${filePath} with ${this.idToLabel.size} entries (capacity: ${this.maxElements})`);
    } catch (e) {
      logger.error(`[HNSWIndex] Failed to load index from ${filePath}`, e);
      throw e;
    }
  }

  rebuild(): void {
    // Compact the index by rebuilding without deleted entries
    // Note: hnswlib doesn't expose vectors directly, so this requires external tracking
    logger.warn('[HNSWIndex] Rebuild requires external vector storage');
  }
}
