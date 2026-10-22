// Defaults < user file < project file, with the "can only do less" rule for
// project files (02-architecture § Text replacements). An untrusted project
// file still turns things off; it never turns anything on.
import { type Diagnostic, makeDiagnostic } from './diagnostics.ts';
import type { LoadedConfig, Shortcut } from './references.ts';
import { compareCodePoints, type JsonValue, type NamesSettings, put, sortDiagnostics } from './schema.ts';

export interface EffectivePlugin {
  /** Absent: the plugin's own default (phase 28's plugin list decides what is installed). */
  readonly enabled?: boolean;
  readonly settings: Readonly<Record<string, JsonValue>>;
}

export interface EffectiveConfig {
  readonly language?: string;
  /** Sorted by shortcut; a project entry replaces a personal one. */
  readonly replacements: readonly Shortcut[];
  /** Shortcuts where a project entry replaced a personal one. */
  readonly overrides: readonly string[];
  /** User words, then project words, without duplicates. */
  readonly protect: readonly string[];
  /** Autocorrect is opt-in: false unless the user file turns it on. */
  readonly autocorrect: boolean;
  /** `[names]` from the user file; a project file may only set enabled = false. */
  readonly names?: NamesSettings;
  /** Phrase learning is opt-in: false unless the user file turns it on. */
  readonly phrasesLearn: boolean;
  /** Only from the user file; overrides the order `murmo plugin` keeps (phase 28). */
  readonly pluginOrder?: readonly string[];
  readonly plugins: Readonly<Record<string, EffectivePlugin>>;
  /** `[privacy] private` from either file; the flag file is checked by the store. */
  readonly private: boolean;
  /** Both files' diagnostics and the merge notices: user file first, then the project file. */
  readonly diagnostics: readonly Diagnostic[];
}

export interface MergeInput {
  readonly user?: LoadedConfig;
  readonly project?: LoadedConfig;
  /** The project snapshot's fingerprint matches an approval (trust check). */
  readonly projectTrusted: boolean;
}

export function mergeConfig({ user, project, projectTrusted }: MergeInput): EffectiveConfig {
  const userFile = user?.status === 'ok' ? user : undefined;
  const projectFile = project?.status === 'ok' ? project : undefined;
  const notices: Diagnostic[] = [];

  const replacements = new Map<string, Shortcut>();
  for (const s of userFile?.replacements ?? []) replacements.set(s.shortcut, s);
  const overrides: string[] = [];
  if (projectFile && projectTrusted) {
    for (const s of projectFile.replacements) {
      if (replacements.has(s.shortcut)) {
        overrides.push(s.shortcut);
        const entry = projectFile.shortcuts.find((e) => e.shortcut === s.shortcut);
        notices.push(
          makeDiagnostic(
            'notice',
            'override',
            projectFile.file,
            entry?.at ?? { line: 1, column: 1 },
            `project shortcut "${s.shortcut}" overrides your personal one`,
          ),
        );
      }
      replacements.set(s.shortcut, s);
    }
  }

  const protect = [...(userFile?.protect ?? [])];
  for (const word of projectFile?.protect ?? []) if (!protect.includes(word)) protect.push(word);

  // parseConfig already dropped what a project file may not turn on (autocorrect,
  // a plugin, `private = false`, `[plugins] order`), with a warning for each.
  const autocorrect = projectFile?.autocorrect === false ? false : (userFile?.autocorrect ?? false);
  const phrasesLearn = projectFile?.phrasesLearn === false ? false : (userFile?.phrasesLearn ?? false);
  const isPrivate = projectFile?.private === true || (userFile?.private ?? false);

  const plugins: Record<string, EffectivePlugin> = {};
  for (const [id, table] of Object.entries(userFile?.plugins ?? {})) {
    put(plugins, id, { ...(table.enabled === undefined ? {} : { enabled: table.enabled }), settings: table.settings });
  }
  let untrustedPlugins = 0;
  for (const [id, table] of Object.entries(projectFile?.plugins ?? {})) {
    const current = plugins[id] ?? { settings: {} };
    const enabled = table.enabled === false ? false : current.enabled;
    let settings = current.settings;
    if (Object.keys(table.settings).length > 0) {
      if (projectTrusted) {
        const merged: Record<string, JsonValue> = {};
        for (const [k, v] of Object.entries(current.settings)) put(merged, k, v);
        for (const [k, v] of Object.entries(table.settings)) put(merged, k, v);
        settings = merged;
      } else untrustedPlugins++;
    }
    put(plugins, id, { ...(enabled === undefined ? {} : { enabled }), settings });
  }

  if (projectFile && !projectTrusted) {
    const shortcuts = projectFile.replacements.length;
    if (shortcuts > 0 || untrustedPlugins > 0) {
      const parts = [
        ...(shortcuts > 0 ? [`${shortcuts} shortcut${shortcuts === 1 ? '' : 's'}`] : []),
        ...(untrustedPlugins > 0
          ? [`settings for ${untrustedPlugins} plugin${untrustedPlugins === 1 ? '' : 's'}`]
          : []),
      ];
      notices.push(
        makeDiagnostic(
          'notice',
          'untrusted',
          projectFile.file,
          { line: 1, column: 1 },
          `${parts.join(' and ')} stay off until you review this file: run "murmo trust"`,
        ),
      );
    }
  }

  const language = projectFile?.language ?? userFile?.language;
  let names = userFile?.names;
  if (projectFile?.names?.enabled === false) {
    names = { ...(names ?? {}), enabled: false };
  }
  return {
    ...(language === undefined ? {} : { language }),
    replacements: [...replacements.values()].sort((a, b) => compareCodePoints(a.shortcut, b.shortcut)),
    overrides: overrides.sort(compareCodePoints),
    protect,
    autocorrect,
    ...(names === undefined ? {} : { names }),
    phrasesLearn,
    ...(userFile?.pluginOrder ? { pluginOrder: userFile.pluginOrder } : {}),
    plugins,
    private: isPrivate,
    // Every merge notice is about the project file.
    diagnostics: [...(user?.diagnostics ?? []), ...sortDiagnostics([...(project?.diagnostics ?? []), ...notices])],
  };
}
