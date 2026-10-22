// Per-host EventCapability maps. `live` only after a real-host run on that
// version; source/replay stays unavailable to plugins (plan/39). OpenCode is
// advertised absent until live startup passes (E10).

import type { AgentCapabilities, AgentEventKind, EventCapability } from '@murmo/api/events';
import { EVENTS_GUARD_BUDGET_MS, EVENTS_NATIVE_TIMEOUT_MS } from '@murmo/api/events';

const FAIL_OPEN: EventCapability['failure'] = 'allow';
const FAIL_CLOSED: EventCapability['failure'] = 'deny';

function bounded(ms: number): EventCapability['deadline'] {
  return { kind: 'bounded', ms };
}

function observe(route: string, evidence: EventCapability['evidence'], coverage: string): EventCapability {
  return {
    observe: true,
    block: false,
    modify: false,
    addContext: false,
    route,
    delivery: 'notification',
    evidence,
    coverage,
    deadline: { kind: 'none' },
    cancellation: false,
    failure: 'allow',
    buffer: { capacity: 256, overflow: 'gap', replay: 'none' },
  };
}

function guard(
  route: string,
  evidence: EventCapability['evidence'],
  coverage: string,
  failure: EventCapability['failure'],
  extra: Partial<EventCapability> = {},
): EventCapability {
  return {
    observe: true,
    block: true,
    modify: false,
    addContext: false,
    route,
    delivery: 'barrier',
    evidence,
    coverage,
    deadline: bounded(EVENTS_GUARD_BUDGET_MS),
    cancellation: true,
    failure,
    buffer: { capacity: 1, overflow: 'gap', replay: 'none' },
    guard: {
      position: 'before-native-peers',
      finalBoundary: false,
      nestedTools: 'unknown',
      postRewriteValidation: 'none',
    },
    ...extra,
  };
}

function contextCap(route: string, evidence: EventCapability['evidence'], coverage: string): EventCapability {
  return {
    observe: true,
    block: false,
    modify: false,
    addContext: true,
    route,
    delivery: 'barrier',
    evidence,
    coverage,
    deadline: bounded(EVENTS_NATIVE_TIMEOUT_MS),
    cancellation: false,
    failure: 'allow',
  };
}

const EMPTY_SEND: AgentCapabilities['sendReceipts'] = {
  acceptance: 'unknown',
  delivery: 'unknown',
  atomicIdle: false,
};

function eventsOf(map: Partial<Record<AgentEventKind, EventCapability>>): AgentCapabilities {
  return { events: map, sendPromptModes: [], sendReceipts: EMPTY_SEND, display: {} };
}

/** Claude 2.1.304: classic hooks + mods. `agent.idle` stays absent until turn.complete is proven settled. */
export function claudeEventCaps(mods: boolean): AgentCapabilities {
  const classicTimeout = bounded(EVENTS_NATIVE_TIMEOUT_MS);
  const tool = guard(
    'classic.PreToolUse',
    'live',
    'local tools; hosted tools and later native peers can still run. fails open after 5000 ms on claude',
    FAIL_OPEN,
    { deadline: classicTimeout },
  );
  const prompt = mods
    ? contextCap(
        'prompt.submit',
        'live',
        'composer-origin acknowledgement; classic UserPromptSubmit context is disabled while mods are active (E13)',
      )
    : contextCap(
        'classic.UserPromptSubmit',
        'live',
        'classic additionalContext; no native human-origin receipt beyond composer origin on mods',
      );
  const caps = eventsOf({
    'session.start': observe(mods ? 'session.start' : 'classic.SessionStart', 'live', 'plugin session'),
    'session.end': observe(mods ? 'session.end' : 'classic.SessionEnd', 'live', 'SessionEnd 1.5 s native default'),
    'tool.before': tool,
    'tool.after': observe('classic.PostToolUse', 'live', 'after the tool ran; start is not executed'),
    'prompt.submit': prompt,
    'turn.end': observe(
      mods ? 'turn.complete' : 'classic.Stop',
      'live',
      'not idle; ghost waits for empty-prompt suggest',
    ),
    'compact.before': observe('classic.PreCompact', 'source', 'classic compaction'),
    'subagent.start': observe('classic.SubagentStart', 'source', 'classic subagent'),
    'subagent.end': observe('classic.SubagentStop', 'source', 'classic subagent'),
    'permission.request': {
      ...guard('classic.PermissionRequest', 'source', 'permission hook', FAIL_OPEN, { deadline: classicTimeout }),
      block: true,
    },
  });
  return {
    ...caps,
    contextTargets: ['next-accepted-human-prompt'],
  };
}

/** Codex 0.163.0: 12 released lifecycle hooks via `murmo hook`. */
export function codexEventCaps(): AgentCapabilities {
  const timeout = bounded(EVENTS_NATIVE_TIMEOUT_MS);
  const tool = guard(
    'murmo hook codex PreToolUse',
    'live',
    'local tools only; hosted tools and write_stdin bypass. fails open after 5000 ms on codex. error/timeout/malformed output allows',
    FAIL_OPEN,
    { deadline: timeout },
  );
  return {
    ...eventsOf({
      'session.start': observe('SessionStart', 'live', 'released hook'),
      'session.end': observe('SessionEnd', 'live', 'SessionEnd at most 3 s'),
      'tool.before': tool,
      'tool.after': observe('PostToolUse', 'live', 'after the tool ran'),
      'prompt.submit': observe('UserPromptSubmit', 'live', 'no human-origin receipt in classic staging (E12)'),
      'agent.idle': observe('Stop+wrapper-idle', 'live', 'Stop plus OSC idle and empty native prompt row'),
      'turn.end': observe('Stop', 'live', 'Stop may continue; not idle'),
      'compact.before': observe('PreCompact', 'source', 'released hook'),
      'compact.after': observe('PostCompact', 'source', 'released hook'),
      'subagent.start': observe('SubagentStart', 'source', 'released hook'),
      'subagent.end': observe('SubagentStop', 'source', 'released hook'),
      'permission.request': guard('PermissionRequest', 'source', 'approval request', FAIL_OPEN, { deadline: timeout }),
      interrupt: observe('Interrupt', 'source', 'observer only; never a guard'),
    }),
    contextTargets: [],
  };
}

/** Pi 1.3.0: awaited extension events. Murmo owns the barrier, default fail-closed. */
export function piEventCaps(failOpen: boolean): AgentCapabilities {
  const failure = failOpen ? FAIL_OPEN : FAIL_CLOSED;
  return {
    ...eventsOf({
      'session.start': observe('session_start', 'live', 'extension'),
      'session.end': observe('session_shutdown', 'live', 'attachment scope, not durable-session deletion'),
      'prompt.submit': observe('input', 'live', 'source may be interactive; RPC is not human provenance (E12)'),
      'message.delta': observe('message_update', 'live', 'text_delta only'),
      'message.complete': observe('message_end', 'live', 'assistant role'),
      'tool.before': guard(
        'tool_call',
        'live',
        'throwing handler prevents execution; Pi does not revalidate mutated input; start is not executed',
        failure,
        {
          deadline: bounded(EVENTS_GUARD_BUDGET_MS),
          guard: {
            position: 'before-native-peers',
            finalBoundary: false,
            nestedTools: 'unknown',
            postRewriteValidation: 'adapter',
          },
        },
      ),
      'tool.after': observe('tool_result', 'live', 'executed unknown unless the result event fired'),
      'tool.error': observe('tool_result', 'live', 'isError'),
      'step.end': observe('turn_end', 'live', 'not idle'),
      'agent.idle': observe('agent_settled', 'live', 'native settled signal'),
      'compact.before': observe('session_before_compact', 'source', 'extension'),
      'compact.after': observe('session_compact', 'source', 'extension'),
    }),
    contextTargets: [],
  };
}

/** OpenCode 2.1.1: source-mapped only until a no-network live start passes (E10). */
export function opencodeEventCaps(): AgentCapabilities {
  return eventsOf({});
}

export function doctorLinesFor(host: string, caps: AgentCapabilities): { name: string; detail: string }[] {
  const rows: { name: string; detail: string }[] = [];
  const kinds = Object.keys(caps.events) as AgentEventKind[];
  if (kinds.length === 0) {
    rows.push({
      name: `events:${host}`,
      detail: 'absent (no live route; OpenCode stays source-only until startup passes)',
    });
    return rows;
  }
  for (const kind of kinds) {
    const cap = caps.events[kind];
    if (!cap) continue;
    const deadline = cap.deadline.kind === 'bounded' ? `${cap.deadline.ms} ms` : cap.deadline.kind;
    const fail =
      cap.failure === 'allow'
        ? `fails open after ${cap.deadline.kind === 'bounded' ? cap.deadline.ms : 'N'} ms on ${host}`
        : cap.failure === 'deny'
          ? `fails closed after ${deadline} on ${host}`
          : `failure ${cap.failure}`;
    rows.push({
      name: `events:${host}:${kind}`,
      detail: `${cap.route} ${cap.delivery} evidence=${cap.evidence} deadline=${deadline} ${fail}. ${cap.coverage}`,
    });
  }
  return rows;
}
