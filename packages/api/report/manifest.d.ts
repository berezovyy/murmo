import { type Capabilities } from './caps.ts';
import { type Permission } from './limits.ts';
/** File name of the manifest inside a plugin package. */
export declare const MANIFEST_FILE = "murmo.plugin.json";
export type CapabilityRequirement = boolean | string | readonly string[];
export interface SettingsProperty {
    readonly type: 'string' | 'boolean' | 'number' | 'integer';
    readonly description?: string;
    readonly enum?: readonly (string | number | boolean)[];
    readonly default?: string | number | boolean;
    /** Numbers and integers only. */
    readonly minimum?: number;
    readonly maximum?: number;
    /** Strings only, in UTF-16 units. */
    readonly maxLength?: number;
}
/** A deliberately bounded JSON Schema subset; any other keyword is refused. */
export interface SettingsSchema {
    readonly type: 'object';
    readonly properties: Readonly<Record<string, SettingsProperty>>;
    readonly required?: readonly string[];
    /** Unknown settings are refused unless this is `true`. */
    readonly additionalProperties?: boolean;
}
export interface PermissionDeclaration {
    readonly name: Permission;
    /** Shown to the user when the host asks for the grant. */
    readonly reason: string;
}
/**
 * Manifest v1. `api` names the core contract, independently of the plugin's own
 * `version`. There is no `builtin` field: built-in trust comes from the host
 * that installs a plugin, never from the plugin's files.
 */
export interface PluginManifest {
    readonly name: string;
    readonly version: string;
    readonly api: string;
    readonly entry: string;
    readonly permissions: readonly PermissionDeclaration[];
    readonly capabilities: {
        readonly required: Readonly<Record<string, CapabilityRequirement>>;
        readonly optional: Readonly<Record<string, CapabilityRequirement>>;
    };
    readonly settingsSchema: SettingsSchema;
    /** Requested guest memory ceiling; above `LIMITS.defaultMemoryMiB` needs reviewed admission. */
    readonly resources?: {
        readonly memoryMiB: number;
    };
}
/** The outcome of negotiation, handed to the plugin as `ctx.negotiation`. */
export interface Negotiation {
    readonly apiVersion: string;
    readonly apiDraft: string;
    /** Every optional path the manifest asked for, and whether this host meets it. */
    readonly optional: Readonly<Record<string, boolean>>;
    readonly missingOptional: readonly string[];
}
/**
 * Core feature paths (`api.<feature>`), with the API version that introduced each.
 * They describe what the core implements, not what the host supports.
 */
export declare const API_FEATURES: {
    readonly 'typed-read-default': '2.0.0';
    readonly 'submit-observe': '2.0.0';
    readonly 'attributed-edits': '2.0.0';
    readonly 'adaptive-budgets': '2.0.0';
};
export type ManifestErrorCode = 'too-large' | 'invalid-json' | 'not-object' | 'missing-field' | 'unknown-field' | 'builtin-field' | 'invalid-name' | 'invalid-version' | 'invalid-range' | 'invalid-entry' | 'invalid-permissions' | 'invalid-capabilities' | 'invalid-resources' | 'invalid-settings-schema' | 'invalid-setting' | 'api-mismatch' | 'capability-unknown' | 'capability-unavailable';
/** Every refusal names a code and the manifest path it is about, e.g. `permissions[1].reason`. */
export declare class ManifestError extends Error {
    readonly code: ManifestErrorCode;
    readonly path: string;
    constructor(code: ManifestErrorCode, path: string, message: string);
}
type Version = readonly [major: number, minor: number, patch: number];
/**
 * Parses `murmo.plugin.json` text: at most `LIMITS.manifestBytes` of UTF-8, then
 * JSON, then `validateManifest`.
 */
export declare function parseManifest(text: string): PluginManifest;
/** Checks every manifest rule and returns a detached copy. Throws `ManifestError`. */
export declare function validateManifest(value: unknown): PluginManifest;
/**
 * True when the stable version `core` is inside `range`. The grammar is strict:
 * exact `2.0.0`, `^2.0.0`, `~2.0.0`, comparators (`>=`, `<=`, `>`, `<`, `=`)
 * combined by spaces (AND) and `||` (OR). Wildcards, partial versions, hyphen
 * ranges and prereleases are an error, never an optimistic match. Caret bounds
 * follow semver for major zero: `^0.2.3` stops before `0.3.0`.
 */
export declare function satisfies(core: string, range: string): boolean;
/** Parses a stable `MAJOR.MINOR.PATCH` version without leading zeros. */
export declare function parseVersion(text: unknown, path?: string): Version;
/** Semver precedence of two stable versions: negative, zero or positive. */
export declare function compareVersions(a: Version, b: Version): number;
/**
 * Settings for the factory: user `input` checked against the schema, defaults
 * filled in for absent keys, required keys enforced. Throws `ManifestError`.
 */
export declare function resolveSettings(manifest: PluginManifest, input?: Readonly<Record<string, unknown>>): Record<string, unknown>;
/**
 * Checks the manifest's `api` range against `core` and its capability
 * requirements against the host's measured `caps`. A missing required capability
 * refuses the plugin; a missing optional one is reported, never invented.
 * Booleans and strings must be equal; a string array must be a subset.
 */
export declare function negotiate(manifest: PluginManifest, caps: Capabilities, core?: string): Negotiation;
export {};
