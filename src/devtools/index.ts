export interface DevtoolsIndexEntry {
  id: 'floor-art' | 'sprite-review' | 'postprocess';
  name: string;
  description: string;
}

export const DEVTOOLS_INDEX_ENTRIES: readonly DevtoolsIndexEntry[] = [
  {
    id: 'floor-art',
    name: 'Floor art + workflow',
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
] as const;
