// `murmo hook codex <event>`: talk to the wrapper session socket. With no
// wrapper (IDE, exec, app-server) print continue immediately so non-wrapped
// Codex is never slowed or blocked (plan/39). A crash still prints a valid
// reply — the host treats malformed output as allow (E5). Never bypass_hook_trust.

import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import { CODEX_RELEASED_HOOKS } from '@murmo/api/events';

export function continueReply(eventName: string): Record<string, unknown> {
  return {
    hookSpecificOutput: { hookEventName: eventName, permissionDecision: 'allow' },
  };
}

export const HOOK_SOCKET_ENV = 'MURMO_HOOK_SOCKET';

export function hookContinue(eventName: string): string {
  return `${JSON.stringify(continueReply(eventName))}\n`;
}

export async function hookCommand(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
  out: (text: string) => void,
): Promise<number> {
  const host = argv[0] ?? '';
  const eventName = argv[1] ?? '';
  const fallback = hookContinue(eventName || 'PreToolUse');
  const write = (text: string) => {
    try {
      out(text.endsWith('\n') ? text : `${text}\n`);
    } catch {
      // stdout gone; the host already treated this as allow
    }
  };
  try {
    if (host !== 'codex') {
      write(fallback);
      return 0;
    }
    if (eventName && !(CODEX_RELEASED_HOOKS as readonly string[]).includes(eventName)) {
      write(hookContinue(eventName));
      return 0;
    }
    const path = env[HOOK_SOCKET_ENV];
    if (!path || !existsSync(path)) {
      write(fallback);
      return 0;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(stdin || '{}') as Record<string, unknown>;
    } catch {
      write(fallback);
      return 0;
    }
    if (!payload.hook_event_name) payload.hook_event_name = eventName;
    const reply = await askSocket(path, JSON.stringify(payload), 40);
    write(reply ?? fallback);
    return 0;
  } catch {
    write(fallback);
    return 0;
  }
}

function askSocket(path: string, body: string, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const conn = createConnection(path);
    const timer = setTimeout(() => {
      conn.destroy();
      resolve(undefined);
    }, timeoutMs);
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('connect', () => {
      conn.write(`${body}\n`);
    });
    conn.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.includes('\n')) {
        clearTimeout(timer);
        conn.end();
        resolve(buf.trim());
      }
    });
    conn.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    conn.on('end', () => {
      clearTimeout(timer);
      resolve(buf.trim() || undefined);
    });
  });
}
