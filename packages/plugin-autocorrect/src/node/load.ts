// Load the English pack from @murmo/lang-en into portable table-source. Tests
// and the conformance Node/Bun launchers call this before a session starts.

import { ensurePack } from '@murmo/lang-en';
import type { EnglishPackAsset } from '../table-source.ts';
import { loadBuiltPack } from './from-dir.ts';

function decodeB64Source(): string {
  return `function(s){s=s.replace(/=+$/,"");var t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",len=Math.floor(s.length*0.75),u=new Uint8Array(len),j=0;for(var i=0;i<s.length;i+=4){var a=t.indexOf(s.charAt(i)),b=t.indexOf(s.charAt(i+1)),c=i+2<s.length?t.indexOf(s.charAt(i+2)):0,d=i+3<s.length?t.indexOf(s.charAt(i+3)):0,x=(a<<18)|(b<<12)|(c<<6)|d;if(j<len)u[j++]=x>>16&255;if(j<len)u[j++]=x>>8&255;if(j<len)u[j++]=x&255;}return u}`;
}

/** Builds the pack if needed, maps it, and installs the English word policy. */
export function loadEnglishPack(dir?: string): EnglishPackAsset {
  return loadBuiltPack(ensurePack(dir));
}

/** Banner the QuickJS guest prepends so it has the table without a filesystem. */
export function englishPackBanner(asset: EnglishPackAsset = loadEnglishPack()): string {
  const b64 = Buffer.from(asset.bytes).toString('base64');
  const keys = JSON.stringify(asset.lowercaseOnly);
  return `globalThis.__MURMO_ENGLISH_PACK={bytes:(${decodeB64Source()})(${JSON.stringify(b64)}),sha256:${JSON.stringify(asset.sha256)},entries:${asset.entries},lowercaseOnly:${keys}};`;
}
