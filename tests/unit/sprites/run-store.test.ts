/**
 * Unit tests for LocalRunStore.
 *
 * Uses a real temp directory so behaviour is exercised at the file system
 * level without any mocks. The Azure implementation is tested separately
 * (integration tests against Azurite — see infra/README.md).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalRunStore } from '../../../scripts/sprites/store/local-store.js';
import { StoreNotFoundError } from '../../../scripts/sprites/store/types.js';

let tmpDir: string;
let store: LocalRunStore;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'crawler-store-test-'));
  store = new LocalRunStore(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('LocalRunStore', () => {
  describe('backend', () => {
    it('reports local backend', () => {
      expect(store.backend).toBe('local');
    });
  });

  describe('put / get', () => {
    it('round-trips binary data', async () => {
      const data = Buffer.from([1, 2, 3, 4]);
      await store.put('brief/run/sheet-00.png', data);
      const result = await store.get('brief/run/sheet-00.png');
      expect(result).toEqual(data);
    });

    it('creates intermediate directories automatically', async () => {
      await store.put('a/b/c/d/e.json', Buffer.from('{}'));
      const result = await store.get('a/b/c/d/e.json');
      expect(result.toString()).toBe('{}');
    });

    it('overwrites an existing key', async () => {
      await store.put('k', Buffer.from('first'));
      await store.put('k', Buffer.from('second'));
      const result = await store.get('k');
      expect(result.toString()).toBe('second');
    });
  });

  describe('get (missing key)', () => {
    it('throws StoreNotFoundError for missing key', async () => {
      await expect(store.get('does/not/exist.png')).rejects.toBeInstanceOf(StoreNotFoundError);
    });

    it('StoreNotFoundError carries the key', async () => {
      try {
        await store.get('missing.json');
      } catch (err) {
        expect(err).toBeInstanceOf(StoreNotFoundError);
        expect((err as StoreNotFoundError).key).toBe('missing.json');
      }
    });
  });

  describe('has', () => {
    it('returns true for an existing key', async () => {
      await store.put('x.png', Buffer.from('px'));
      expect(await store.has('x.png')).toBe(true);
    });

    it('returns false for a missing key', async () => {
      expect(await store.has('nope.png')).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all keys under a prefix directory', async () => {
      await store.put('brief/run1/sheet.png', Buffer.from(''));
      await store.put('brief/run1/summary.json', Buffer.from(''));
      await store.put('brief/run2/sheet.png', Buffer.from(''));

      const keys = await store.list('brief/run1');
      expect([...keys].sort()).toEqual(['brief/run1/sheet.png', 'brief/run1/summary.json'].sort());
    });

    it('returns empty array when prefix does not exist', async () => {
      const keys = await store.list('missing/prefix');
      expect(keys).toEqual([]);
    });

    it('returns the key itself when prefix is a file', async () => {
      await store.put('solo.json', Buffer.from('{}'));
      const keys = await store.list('solo.json');
      expect(keys).toEqual(['solo.json']);
    });
  });

  describe('remove', () => {
    it('deletes an existing key', async () => {
      await store.put('del.png', Buffer.from('bye'));
      await store.remove('del.png');
      expect(await store.has('del.png')).toBe(false);
    });

    it('does not throw when key is missing', async () => {
      await expect(store.remove('ghost.png')).resolves.toBeUndefined();
    });

    it('can remove a directory tree by prefix', async () => {
      await store.put('run/a.png', Buffer.from(''));
      await store.put('run/b.json', Buffer.from(''));
      await store.remove('run');
      expect(await store.has('run/a.png')).toBe(false);
    });
  });

  describe('resolve', () => {
    it('returns an absolute path inside tmpDir', () => {
      const resolved = store.resolve('brief/run/file.png');
      expect(path.isAbsolute(resolved)).toBe(true);
      expect(resolved.startsWith(tmpDir)).toBe(true);
    });

    it('does not allow path traversal outside root', () => {
      const resolved = store.resolve('../../etc/passwd');
      expect(resolved.startsWith(tmpDir)).toBe(true);
    });
  });
});
