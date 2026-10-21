// Load the English pack from @murmo/lang-en into portable table-source. Tests
// and the conformance Node/Bun launchers call this before a session starts.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCasePolicy, parseManifest } from '@murmo/lang';
import { ensurePack, PACK_FILES } from '@murmo/lang-en';
import { installEnglishPolicy } from '../rules.ts';
import { type EnglishPackAsset, provideEnglishPack } from '../table-source.ts';

function alignedCopy(source: Uint8Array): Uint8Array {
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function decodeB64Source(): string {
  return `function(s){s=s.replace(/=+$/,"");var t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",len=Math.floor(s.length*0.75),u=new Uint8Array(len),j=0;for(var i=0;i<s.length;i+=4){var a=t.indexOf(s.charAt(i)),b=t.indexOf(s.charAt(i+1)),c=i+2<s.length?t.indexOf(s.charAt(i+2)):0,d=i+3<s.length?t.indexOf(s.charAt(i+3)):0,x=(a<<18)|(b<<12)|(c<<6)|d;if(j<len)u[j++]=x>>16&255;if(j<len)u[j++]=x>>8&255;if(j<len)u[j++]=x&255;}return u}`;
}

/** Builds the pack if needed, maps it, and installs the English word policy. */
export function loadEnglishPack(dir?: string): EnglishPackAsset {
  const packDir = ensurePack(dir);
  const tableBytes = alignedCopy(readFileSync(join(packDir, PACK_FILES.table)));
  const manifest = parseManifest(JSON.parse(readFileSync(join(packDir, PACK_FILES.manifest), 'utf8')));
  const caseJson = JSON.parse(readFileSync(join(packDir, PACK_FILES.casePolicy), 'utf8'));
  const casePolicy = parseCasePolicy(caseJson);
  const asset: EnglishPackAsset = {
    bytes: tableBytes,
    sha256: sha256(tableBytes),
    entries: manifest.table.entries,
    lowercaseOnly: [...casePolicy.lowercaseOnly],
  };
  provideEnglishPack(asset);
  installEnglishPolicy(casePolicy.lowercaseOnly);
  return asset;
}

/** Banner the QuickJS guest prepends so it has the table without a filesystem. */
export function englishPackBanner(asset: EnglishPackAsset = loadEnglishPack()): string {
  const b64 = Buffer.from(asset.bytes).toString('base64');
  const keys = JSON.stringify(asset.lowercaseOnly);
  return `globalThis.__MURMO_ENGLISH_PACK={bytes:(${decodeB64Source()})(${JSON.stringify(b64)}),sha256:${JSON.stringify(asset.sha256)},entries:${asset.entries},lowercaseOnly:${keys}};`;
}
