// The English pack's table bytes, SHA-256 and lowercase-only keys. Portable
// code never reads the filesystem: Node/Bun loaders and the QuickJS guest
// banner call `provideEnglishPack` before a session starts.

export interface EnglishPackAsset {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly entries: number;
  readonly lowercaseOnly: readonly string[];
}

const slot: EnglishPackAsset[] = [];

export function provideEnglishPack(asset: EnglishPackAsset): void {
  slot[0] = asset;
}

export function englishPackAsset(): EnglishPackAsset | undefined {
  const injected = (globalThis as { __MURMO_ENGLISH_PACK?: EnglishPackAsset }).__MURMO_ENGLISH_PACK;
  return slot[0] ?? injected;
}
