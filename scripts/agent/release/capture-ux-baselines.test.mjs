import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Release UX Baselines', () => {
  describe('manifest.json', () => {
    test('manifest.json exists and is valid JSON', () => {
      const manifestPath = resolve('docs/knowledge/ux-baselines/manifest.json');
      assert.ok(existsSync(manifestPath), 'manifest.json should exist');

      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);
      assert.ok(Array.isArray(manifest), 'manifest should be an array');
    });

    test('manifest entries have required fields', () => {
      const manifestPath = resolve('docs/knowledge/ux-baselines/manifest.json');
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      const requiredFields = ['id', 'label', 'viewport', 'captureSource', 'setupFile', 'enabled'];
      for (const surface of manifest) {
        for (const field of requiredFields) {
          assert.ok(
            Object.prototype.hasOwnProperty.call(surface, field),
            `Surface should have ${field}`,
          );
        }
      }
    });

    test('manifest surface IDs are unique and lowercase', () => {
      const manifestPath = resolve('docs/knowledge/ux-baselines/manifest.json');
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      const ids = new Set();
      for (const surface of manifest) {
        assert.ok(/^[a-z0-9-]+$/.test(surface.id), `ID "${surface.id}" should match [a-z0-9-]+`);
        assert.ok(!ids.has(surface.id), `ID "${surface.id}" should be unique`);
        ids.add(surface.id);
      }
    });

    test('manifest viewports are valid numbers', () => {
      const manifestPath = resolve('docs/knowledge/ux-baselines/manifest.json');
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      for (const surface of manifest) {
        assert.ok(
          typeof surface.viewport.width === 'number' && surface.viewport.width > 0,
          'viewport.width must be positive number',
        );
        assert.ok(
          typeof surface.viewport.height === 'number' && surface.viewport.height > 0,
          'viewport.height must be positive number',
        );
      }
    });

    test('manifest includes equipment surface as enabled', () => {
      const manifestPath = resolve('docs/knowledge/ux-baselines/manifest.json');
      const content = readFileSync(manifestPath, 'utf-8');
      const manifest = JSON.parse(content);

      const equipment = manifest.find((s) => s.id === 'equipment');
      assert.ok(equipment, 'equipment surface should be in manifest');
      assert.strictEqual(equipment.enabled, true, 'equipment should be enabled');
      assert.strictEqual(equipment.viewport.width, 1280, 'equipment viewport width should be 1280');
      assert.strictEqual(equipment.viewport.height, 800, 'equipment viewport height should be 800');
    });
  });

  describe('baseline-manifest.schema.json', () => {
    test('schema.json exists and is valid JSON', () => {
      const schemaPath = resolve(
        'docs/knowledge/ux-baselines/schemas/baseline-manifest.schema.json',
      );
      assert.ok(existsSync(schemaPath), 'schema.json should exist');

      const content = readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(content);
      assert.ok(schema.$schema, 'schema should have $schema property');
    });

    test('schema defines required properties', () => {
      const schemaPath = resolve(
        'docs/knowledge/ux-baselines/schemas/baseline-manifest.schema.json',
      );
      const content = readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(content);

      const itemSchema = schema.items;
      const required = itemSchema.required;
      assert.ok(
        required.includes('id') &&
          required.includes('label') &&
          required.includes('viewport') &&
          required.includes('captureSource'),
        'schema should require id, label, viewport, captureSource',
      );
    });
  });

  describe('directory structure', () => {
    test('docs/knowledge/ux-baselines/ directory exists', () => {
      const dir = resolve('docs/knowledge/ux-baselines');
      assert.ok(existsSync(dir), 'ux-baselines directory should exist');
    });

    test('docs/knowledge/ux-baselines/schemas/ directory exists', () => {
      const dir = resolve('docs/knowledge/ux-baselines/schemas');
      assert.ok(existsSync(dir), 'schemas directory should exist');
    });

    test('README.md exists and documents the process', () => {
      const readmePath = resolve('docs/knowledge/ux-baselines/README.md');
      assert.ok(existsSync(readmePath), 'README.md should exist');

      const content = readFileSync(readmePath, 'utf-8');
      assert.ok(
        content.includes('Capturing/Updating Baselines'),
        'README should document capture process',
      );
      assert.ok(
        content.includes('release:capture-ux-baselines'),
        'README should mention the capture script',
      );
    });
  });

  describe('capture script', () => {
    test('capture-ux-baselines.ts exists and is readable', () => {
      const scriptPath = resolve('scripts/agent/release/capture-ux-baselines.ts');
      assert.ok(existsSync(scriptPath), 'capture-ux-baselines.ts should exist');

      const content = readFileSync(scriptPath, 'utf-8');
      assert.ok(content.includes('readManifest'), 'script should read manifest');
      assert.ok(content.includes('captureEquipmentSurface'), 'script should capture equipment');
    });

    test('capture script has proper argument parsing', () => {
      const scriptPath = resolve('scripts/agent/release/capture-ux-baselines.ts');
      const content = readFileSync(scriptPath, 'utf-8');

      assert.ok(content.includes('parseArgs'), 'script should parse CLI args');
      assert.ok(content.includes('--ref'), 'script should support --ref flag');
      assert.ok(content.includes('--release-dir'), 'script should support --release-dir flag');
    });
  });

  describe('npm script integration', () => {
    test('package.json defines release:capture-ux-baselines script', () => {
      const packagePath = resolve('package.json');
      const content = readFileSync(packagePath, 'utf-8');
      const pkg = JSON.parse(content);

      assert.ok(
        pkg.scripts['release:capture-ux-baselines'],
        'package.json should define release:capture-ux-baselines script',
      );
      assert.ok(
        pkg.scripts['release:capture-ux-baselines'].includes('capture-ux-baselines.ts'),
        'script should call the capture script',
      );
    });
  });
});
