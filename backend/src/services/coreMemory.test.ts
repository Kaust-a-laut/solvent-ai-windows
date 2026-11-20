import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoreMemory, CoreMemoryFactory } from './coreMemory';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import path from 'path';

const TEST_PATH = '/tmp/test_core_memory.json';
const SESSION_PATH = '/tmp/test_session_123.json';

describe('CoreMemory', () => {
  let core: CoreMemory;

  beforeEach(() => {
    if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
    if (existsSync(SESSION_PATH)) unlinkSync(SESSION_PATH);
    core = new CoreMemory(TEST_PATH, 10);
  });

  afterEach(async () => {
    await core.flush();
    if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
    if (existsSync(SESSION_PATH)) unlinkSync(SESSION_PATH);
  });

  it('should set and get a key', () => {
    core.set('user_name', 'Caleb');
    expect(core.get('user_name')).toBe('Caleb');
  });

  it('should list all entries', () => {
    core.set('user_name', 'Caleb');
    core.set('project', 'Solvent AI');
    const all = core.getAll();
    expect(all).toHaveLength(2);
    expect(all.find(e => e.key === 'user_name')!.value).toBe('Caleb');
  });

  it('should delete a key', () => {
    core.set('temp', 'data');
    core.delete('temp');
    expect(core.get('temp')).toBeUndefined();
  });

  it('should enforce max slots', () => {
    for (let i = 0; i < 10; i++) {
      core.set(`key${i}`, `value${i}`);
    }
    expect(() => core.set('key10', 'overflow')).toThrow('Core memory full');
  });

  it('should allow overwrite of existing key without counting as new slot', () => {
    core.set('key', 'v1');
    core.set('key', 'v2');
    expect(core.get('key')).toBe('v2');
    expect(core.getAll()).toHaveLength(1);
  });

  it('should persist to disk and reload', async () => {
    core.set('persistent', 'data');
    await core.flush();

    const core2 = new CoreMemory(TEST_PATH, 10);
    expect(core2.get('persistent')).toBe('data');
  });

  it('should render as context block without header', () => {
    core.set('user_name', 'Caleb');
    core.set('project', 'Solvent AI');
    const block = core.toContextBlock();
    expect(block).toContain('user_name: Caleb');
    expect(block).toContain('project: Solvent AI');
    expect(block).not.toContain('[CORE MEMORY');
  });
});

describe('CoreMemory key-based limits', () => {
  it('should enforce default limit for unknown keys', () => {
    const limitedCore = new CoreMemory(TEST_PATH, 50, { default: 10 });
    expect(() => limitedCore.set('random_key', 'this is too long')).toThrow('exceeds max length');
  });

  it('should allow longer values for blessed keys', () => {
    const limitedCore = new CoreMemory(TEST_PATH, 50);
    const longValue = 'a'.repeat(1500);
    expect(() => limitedCore.set('project_context', longValue)).not.toThrow();
    expect(limitedCore.get('project_context')).toBe(longValue);
  });

  it('should enforce short limit for user_name', () => {
    const limitedCore = new CoreMemory(TEST_PATH, 50);
    expect(() => limitedCore.set('user_name', 'a'.repeat(150))).toThrow('exceeds max length');
  });

  it('should allow short values for user_name', () => {
    const limitedCore = new CoreMemory(TEST_PATH, 50);
    limitedCore.set('user_name', 'Caleb');
    expect(limitedCore.get('user_name')).toBe('Caleb');
  });
});

describe('CoreMemoryFactory', () => {
  it('should create global instance', async () => {
    const globalCore = CoreMemoryFactory.createGlobal();
    globalCore.set('test_global', 'value');
    expect(globalCore.get('test_global')).toBe('value');
    await globalCore.flush();
  });

  it('should respect custom maxSlots', () => {
    const customCore = new CoreMemory('/tmp/test_core_memory_custom_slots.json', 5);
    for (let i = 0; i < 5; i++) {
      customCore.set(`key${i}`, 'value');
    }
    expect(() => customCore.set('overflow', 'fail')).toThrow('Core memory full');
  });
});

describe('CoreMemory async save', () => {
  it('should save asynchronously and be flushable', async () => {
    const testPath = path.join(__dirname, '../../.solvent_core_memory_async_test.json');
    const cm = new CoreMemory(testPath, 10);
    cm.set('key1', 'value1');
    await cm.flush();
    const data = JSON.parse(readFileSync(testPath, 'utf-8'));
    expect(data).toHaveLength(1);
    expect(data[0].key).toBe('key1');
    unlinkSync(testPath);
  });
});
