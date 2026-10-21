// Built-in autocorrect: registers no async typo path. Activate reports why
// correction is off; the core interpreter applies the English table from
// InlineRules the host attached at load.

import type { Effect, Plugin, PluginContext, PluginFactory, PluginManifest } from '@murmo/api';
import { emptyMetrics, formatDoctorMetrics } from './metrics.ts';
import { englishInlineRules } from './rules.ts';
import { type AutocorrectSettings, resolveAutocorrectSettings } from './settings.ts';
import { disabledReason } from './status.ts';
import { englishPackAsset } from './table-source.ts';

export const AUTOCORRECT_MANIFEST = {
  name: 'autocorrect',
  version: '1.0.0',
  api: '^2.0.0',
  entry: 'plugin.mjs',
  permissions: [
    { name: 'draft:read', reason: 'See the words you type so a fully typed typo can be corrected.' },
    { name: 'draft:write', reason: 'Register the English inline table; the core applies it, not this plugin.' },
  ],
  capabilities: {
    required: { 'edit.atomic': true, 'edit.exactRestore': true },
    optional: {
      inputOriginEvidence: 'host-labeled',
      inlineRewrite: ['same-transaction', 'immediate-managed-transport', 'next-key'],
      status: true,
      'ui.dialogSafe': true,
    },
  },
  settingsSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: false, description: 'Opt-in until human validation (phase 30).' },
      language: { type: 'string', default: 'en', maxLength: 16, description: 'Only en is shipped.' },
      allow: { type: 'string', default: '', maxLength: 4096, description: 'Words that must never be corrected.' },
    },
    additionalProperties: false,
  },
} as const satisfies PluginManifest;

export function createAutocorrectPlugin(settings: Readonly<Record<string, unknown>> = {}): Plugin {
  const resolved: AutocorrectSettings = resolveAutocorrectSettings(settings);
  const metrics = emptyMetrics();
  return {
    name: AUTOCORRECT_MANIFEST.name,
    version: AUTOCORRECT_MANIFEST.version,
    permissions: ['draft:read', 'draft:write'],
    activate(ctx: PluginContext): Effect[] | undefined {
      const reason = disabledReason(
        resolved,
        {
          inputOriginEvidence: ctx.host.caps.inputOriginEvidence,
          inlineRewrite: ctx.host.caps.inlineRewrite,
          commitReceipt: ctx.host.caps.inline.commitReceipt,
        },
        englishPackAsset() !== undefined,
      );
      if (reason) {
        if (reason.kind === 'off') metrics.abstained.disabled++;
        else if (reason.kind === 'language') metrics.abstained.language++;
        else if (reason.kind === 'origin') metrics.abstained.origin++;
      }
      if (!reason || !ctx.host.caps.ui.dialogSafe || !ctx.host.caps.status) return undefined;
      return [{ type: 'status', text: reason.text, baseVersion: ctx.draft.version }];
    },
  };
}

/** Doctor line: counters plus the disabled reason, never the draft text. */
export function doctorLine(settings: AutocorrectSettings, applied: number, rejected: number): string {
  const metrics = emptyMetrics();
  metrics.applied = applied;
  metrics.rejected = rejected;
  const reason = disabledReason(settings, { inputOriginEvidence: 'host-labeled' }, englishPackAsset() !== undefined);
  return formatDoctorMetrics(metrics, reason?.text);
}

export const autocorrectFactory: PluginFactory = createAutocorrectPlugin;

export default createAutocorrectPlugin;

/** Factory plus English inline data when the pack is loaded (tests, core subject). */
export function autocorrectSpec(
  id: string,
  settings: Readonly<Record<string, unknown>> = {},
  vocabulary: readonly string[] = [],
): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly inline?: ReturnType<typeof englishInlineRules>['rules'][];
  readonly assets?: ReturnType<typeof englishInlineRules>['assets'];
} {
  const resolved = resolveAutocorrectSettings(settings);
  const pack = englishPackAsset();
  const base = { id, builtin: true as const, factory: autocorrectFactory, settings };
  if (!pack) return base;
  const bundle = englishInlineRules({ owner: id, pack, settings: resolved, vocabulary });
  return { ...base, inline: [bundle.rules], assets: bundle.assets };
}
