export interface DevtoolsIndexEntry {
  id: 'sprite-generation-workflow' | 'sprite-review' | 'postprocess' | 'achievements' | 'storage';
  name: string;
  description: string;
}

export const DEVTOOLS_INDEX_ENTRIES: readonly DevtoolsIndexEntry[] = [
  {
    id: 'sprite-generation-workflow',
    name: 'Sprite Generation Workflow',
    description:
      'Track the asset backlog, queue one-liner → brief → generation → approval → metadata, and inspect integration status.',
  },
  {
    id: 'sprite-review',
    name: 'Sprite review',
    description: 'Read-only viewer for approved sprite sheets, variants, and pipeline traces.',
  },
  {
    id: 'postprocess',
    name: 'Postprocess debugger',
    description:
      'Inspect pipeline steps, validate sheet slicing, and trace live postprocess output.',
  },
  {
    id: 'achievements',
    name: 'Achievements editor',
    description:
      'View all Floor 1 achievements, edit title/criteria/flavor/reward overrides, and review icon + loot-box art backlog.',
  },
  {
    id: 'storage',
    name: 'Azure storage lifecycle',
    description:
      'List, search, archive, and delete sprite-run blobs in Azure storage across active and archive scopes.',
  },
] as const;
