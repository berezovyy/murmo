#!/usr/bin/env node
// Fake LSP stdio server for indexer tests: ok | hang | crash | outside.

import { Buffer } from 'node:buffer';
import { stdin, stdout } from 'node:process';

const mode = process.argv.includes('--hang')
  ? 'hang'
  : process.argv.includes('--crash')
    ? 'crash'
    : process.argv.includes('--outside')
      ? 'outside'
      : 'ok';

const root = process.env.FAKE_LSP_ROOT || process.cwd();
const rootUri = root.startsWith('/') ? `file://${root}` : `file:///${root}`;

function write(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  stdout.write(body);
}

async function* messages() {
  let buf = Buffer.alloc(0);
  for await (const chunk of stdin) {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = buf.subarray(0, headerEnd).toString('utf8');
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buf = buf.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = headerEnd + 4;
      if (buf.length < start + len) break;
      const json = JSON.parse(buf.subarray(start, start + len).toString('utf8'));
      buf = buf.subarray(start + len);
      yield json;
    }
  }
}

function symbols() {
  if (mode === 'outside') {
    return [
      {
        name: 'OutsideType',
        kind: 5,
        location: {
          uri: 'file:///tmp/not-in-repo/out.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        },
      },
    ];
  }
  return [
    {
      name: 'LspOnlyType',
      kind: 5,
      location: {
        uri: `${rootUri}/src/lsp_only.ts`,
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 11 } },
      },
    },
    {
      name: 'ignoredVariable',
      kind: 13,
      location: {
        uri: `${rootUri}/src/lsp_only.ts`,
        range: { start: { line: 8, character: 0 }, end: { line: 8, character: 1 } },
      },
    },
  ];
}

for await (const msg of messages()) {
  if (
    msg.method &&
    msg.id !== undefined &&
    msg.method !== 'initialize' &&
    msg.method !== 'shutdown' &&
    msg.method !== 'workspace/symbol' &&
    msg.method !== 'textDocument/documentSymbol'
  ) {
    write({ jsonrpc: '2.0', id: msg.id, result: null });
    continue;
  }
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: { capabilities: { workspaceSymbolProvider: true, documentSymbolProvider: true } },
    });
    if (mode === 'crash') process.exit(1);
    if (mode === 'hang') await new Promise(() => {});
    continue;
  }
  if (msg.method === 'initialized') continue;
  if (msg.method === 'workspace/symbol') {
    write({ jsonrpc: '2.0', id: msg.id, result: symbols() });
    continue;
  }
  if (msg.method === 'textDocument/documentSymbol') {
    write({ jsonrpc: '2.0', id: msg.id, result: [] });
    continue;
  }
  if (msg.method === 'shutdown') {
    write({ jsonrpc: '2.0', id: msg.id, result: null });
    continue;
  }
  if (msg.method === 'exit') process.exit(0);
}
