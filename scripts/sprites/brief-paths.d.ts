import { type Brief } from './brief-schema.js';
type SpriteType = Brief['type'];
export declare const BRIEF_DIRECTORY_BY_TYPE: Readonly<Record<SpriteType, string>>;
export declare function isSpriteType(value: string): value is SpriteType;
export declare function briefDirectoryForType(type: SpriteType): string;
export {};
//# sourceMappingURL=brief-paths.d.ts.map
