// Opt-in settings, project disable, allowlist. Catches an opt-in leak (E9)
// and a project file turning correction on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LEARN_ALLOWLIST, noteLearnedRejection } from '../src/learn.ts';
import { emptyMetrics, formatDoctorMetrics } from '../src/metrics.ts';
import { correctionEnabled, resolveAutocorrectSettings } from '../src/settings.ts';
import { disabledReason, STATUS } from '../src/status.ts';

test('default config is off until enabled = true (opt-in)', () => {
  const defaults = resolveAutocorrectSettings({});
  assert.equal(defaults.enabled, false);
  assert.equal(defaults.language, 'en');
  assert.equal(correctionEnabled(defaults), false);
  assert.equal(correctionEnabled(resolveAutocorrectSettings({ enabled: true })), true);
});

test('a non-en language turns correction off even when enabled', () => {
  assert.equal(correctionEnabled(resolveAutocorrectSettings({ enabled: true, language: 'de' })), false);
  assert.equal(correctionEnabled(resolveAutocorrectSettings({ enabled: true, language: 'en' })), true);
});

test('allow is a comma/space list; arrays from fixtures also parse', () => {
  assert.deepEqual(resolveAutocorrectSettings({ allow: 'teh, Ratatui' }).allow, ['teh', 'Ratatui']);
  assert.deepEqual(resolveAutocorrectSettings({ allow: ['teh', 'adn'] }).allow, ['teh', 'adn']);
});

test('disabled reasons name the gate (table, origin, language, off)', () => {
  const on = resolveAutocorrectSettings({ enabled: true });
  assert.equal(disabledReason(on, { inputOriginEvidence: 'host-labeled' }, true), undefined);
  assert.equal(disabledReason(on, { inputOriginEvidence: 'host-labeled' }, false)?.kind, 'table');
  assert.equal(disabledReason(on, { inputOriginEvidence: 'observed-unmarked' }, true)?.kind, 'origin');
  assert.equal(
    disabledReason(resolveAutocorrectSettings({ enabled: true, language: 'uk' }), {}, true)?.text,
    STATUS.language('uk'),
  );
  assert.equal(disabledReason(resolveAutocorrectSettings({}), {}, true)?.kind, 'off');
});

test('learned allowlist is a no-op until phases 14 and 19 (flag off)', () => {
  assert.equal(LEARN_ALLOWLIST, false);
  const result = noteLearnedRejection('teh', 'd1', Date.now(), [], false);
  assert.equal(result.allow, null);
  assert.deepEqual(result.records, []);
});

test('doctor line is numbers plus a disabled reason, never draft text', () => {
  const line = formatDoctorMetrics(emptyMetrics(), STATUS.off);
  assert.match(line, /applied 0/);
  assert.match(line, /rejected 0/);
  assert.equal(line.includes('teh'), false);
});
