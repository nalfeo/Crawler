import { beforeEach, describe, expect, it } from 'vitest';
import { getAllLabs, getLab, registerLab, type LabDefinition } from '../../src/labs/registry.js';

describe('lab registry', () => {
  beforeEach(() => {
    getAllLabs().clear();
  });

  it('registerLab adds a lab to the registry', () => {
    const lab: LabDefinition = {
      name: 'Movement Sandbox',
      description: 'Prototype movement tuning.',
      create: () => undefined,
    };

    registerLab('movement', lab);

    expect(getAllLabs().size).toBe(1);
    expect(getAllLabs().has('movement')).toBe(true);
  });

  it('getLab returns the correct lab', () => {
    const create = () => undefined;
    registerLab('combat', {
      name: 'Combat Sandbox',
      description: 'Prototype combat rules.',
      create,
    });

    expect(getLab('combat')).toEqual({
      name: 'Combat Sandbox',
      description: 'Prototype combat rules.',
      create,
    });
  });

  it('getAllLabs returns all registered labs', () => {
    registerLab('alpha', {
      name: 'Alpha',
      description: 'Alpha lab',
      create: () => undefined,
    });
    registerLab('beta', {
      name: 'Beta',
      description: 'Beta lab',
      create: () => undefined,
    });

    expect([...getAllLabs().keys()]).toEqual(['alpha', 'beta']);
  });

  it('duplicate registration overwrites the previous lab definition', () => {
    registerLab('shared-id', {
      name: 'Original',
      description: 'First version',
      create: () => undefined,
    });

    const replacementCreate = () => undefined;
    registerLab('shared-id', {
      name: 'Replacement',
      description: 'Second version',
      create: replacementCreate,
    });

    expect(getAllLabs().size).toBe(1);
    expect(getLab('shared-id')).toEqual({
      name: 'Replacement',
      description: 'Second version',
      create: replacementCreate,
    });
  });
});
