export type LabCategory =
  | 'Combat'
  | 'Movement & Physics'
  | 'Items & Equipment'
  | 'Progression'
  | 'Entities'
  | 'Meta';

export interface LabDefinition {
  name: string;
  description: string;
  category?: LabCategory;
  /** Create and start the lab. Returns a cleanup function. */
  create: (canvas: HTMLElement, controls: HTMLElement) => (() => void) | void;
}

const labs = new Map<string, LabDefinition>();

/** Duplicate registrations replace the previous lab definition for that id. */
export function registerLab(id: string, lab: LabDefinition): void {
  labs.set(id, lab);
}

export function getLab(id: string): LabDefinition | undefined {
  return labs.get(id);
}

export function getAllLabs(): Map<string, LabDefinition> {
  return labs;
}
