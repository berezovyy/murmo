// A JSON Schema validator for the subset fixtures/schema/ uses (draft 2020-12
// keywords: type, properties, required, additionalProperties, items,
// prefixItems, min/maxItems, enum, const, oneOf, anyOf, minimum, minLength,
// pattern, $ref, $defs). A keyword outside the subset is an error in the
// schema, not silently ignored: an ignored keyword would let malformed cases
// through, which is the vacuous-test failure the schemas exist to stop (E13).

export type Schema = { [keyword: string]: unknown } | boolean;

export interface SchemaError {
  path: string;
  message: string;
}

const annotations = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', '$defs']);
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'enum',
  'const',
  'oneOf',
  'anyOf',
  'minimum',
  'minLength',
  'pattern',
  '$ref',
]);

/** Schemas by file name (`common.json`), so `$ref: "common.json#/$defs/step"` resolves. */
export type SchemaSet = Record<string, Schema>;

export function validate(schemas: SchemaSet, root: string, value: unknown): SchemaError[] {
  const schema = schemas[root];
  if (schema === undefined) throw new Error(`no schema "${root}"`);
  const errors: SchemaError[] = [];
  check(schemas, root, schema, value, '$', errors);
  return errors;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(expected: string, actual: string): boolean {
  return expected === actual || (expected === 'number' && actual === 'integer');
}

function resolveRef(schemas: SchemaSet, file: string, ref: string): { file: string; schema: Schema } {
  const [target, pointer = ''] = ref.split('#');
  const name = target || file;
  let node: unknown = schemas[name];
  if (node === undefined) throw new Error(`schema ${file}: $ref to unknown file "${name}"`);
  for (const part of pointer.split('/').filter(Boolean)) {
    node = (node as Record<string, unknown> | undefined)?.[part];
    if (node === undefined) throw new Error(`schema ${file}: unresolved $ref "${ref}"`);
  }
  return { file: name, schema: node as Schema };
}

function check(schemas: SchemaSet, file: string, schema: Schema, value: unknown, path: string, errors: SchemaError[]) {
  if (schema === true) return;
  if (schema === false) {
    errors.push({ path, message: 'is not allowed here' });
    return;
  }
  for (const key of Object.keys(schema)) {
    if (!keywords.has(key) && !annotations.has(key)) throw new Error(`schema ${file}: unsupported keyword "${key}"`);
  }
  const s = schema as Record<string, unknown>;
  if (typeof s.$ref === 'string') {
    const target = resolveRef(schemas, file, s.$ref);
    check(schemas, target.file, target.schema, value, path, errors);
  }
  const actual = typeOf(value);
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => matchesType(t, actual))) {
      errors.push({ path, message: `must be ${types.join(' or ')}, not ${actual}` });
      return;
    }
  }
  if (s.const !== undefined && JSON.stringify(value) !== JSON.stringify(s.const)) {
    errors.push({ path, message: `must be ${JSON.stringify(s.const)}` });
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path, message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}` });
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      errors.push({ path, message: `must have at least ${s.minLength} characters` });
    }
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(value)) {
      errors.push({ path, message: `must match ${s.pattern}` });
    }
  }
  if (typeof value === 'number' && typeof s.minimum === 'number' && value < s.minimum) {
    errors.push({ path, message: `must be at least ${s.minimum}` });
  }
  if (Array.isArray(value)) checkArray(schemas, file, s, value, path, errors);
  else if (actual === 'object') checkObject(schemas, file, s, value as Record<string, unknown>, path, errors);
  if (Array.isArray(s.anyOf)) {
    const branches = s.anyOf.map((branch) => attempt(schemas, file, branch as Schema, value, path));
    if (!branches.some((b) => b.length === 0)) errors.push(...closest(branches, path, 'any allowed shape'));
  }
  if (Array.isArray(s.oneOf)) {
    const branches = s.oneOf.map((branch) => attempt(schemas, file, branch as Schema, value, path));
    const passing = branches.filter((b) => b.length === 0).length;
    if (passing === 0) errors.push(...closest(branches, path, 'any allowed shape'));
    else if (passing > 1) errors.push({ path, message: `matches ${passing} shapes; exactly one is allowed` });
  }
}

function checkArray(
  schemas: SchemaSet,
  file: string,
  s: Record<string, unknown>,
  value: unknown[],
  path: string,
  errors: SchemaError[],
) {
  if (typeof s.minItems === 'number' && value.length < s.minItems) {
    errors.push({ path, message: `must have at least ${s.minItems} items` });
  }
  if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
    errors.push({ path, message: `must have at most ${s.maxItems} items` });
  }
  const prefix = Array.isArray(s.prefixItems) ? (s.prefixItems as Schema[]) : [];
  value.forEach((item, i) => {
    const itemSchema = i < prefix.length ? prefix[i] : (s.items as Schema | undefined);
    if (itemSchema !== undefined) check(schemas, file, itemSchema, item, `${path}[${i}]`, errors);
  });
}

function checkObject(
  schemas: SchemaSet,
  file: string,
  s: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  errors: SchemaError[],
) {
  const properties = (s.properties ?? {}) as Record<string, Schema>;
  for (const name of (s.required ?? []) as string[]) {
    if (!(name in value)) errors.push({ path, message: `needs "${name}"` });
  }
  for (const [name, item] of Object.entries(value)) {
    const child = `${path}.${name}`;
    const propertySchema = properties[name];
    if (propertySchema !== undefined) check(schemas, file, propertySchema, item, child, errors);
    else if (s.additionalProperties === false) errors.push({ path: child, message: 'is not a known field' });
    else if (typeof s.additionalProperties === 'object') {
      check(schemas, file, s.additionalProperties as Schema, item, child, errors);
    }
  }
}

function attempt(schemas: SchemaSet, file: string, schema: Schema, value: unknown, path: string): SchemaError[] {
  const errors: SchemaError[] = [];
  check(schemas, file, schema, value, path, errors);
  return errors;
}

/** The branch that came closest explains the failure best (e.g. the step kind whose key was present). */
function closest(branches: SchemaError[][], path: string, what: string): SchemaError[] {
  const ranked = branches
    .map((errors) => ({
      errors,
      missing: errors.filter((e) => e.path === path && e.message.startsWith('needs')).length,
    }))
    .sort((a, b) => a.missing - b.missing || a.errors.length - b.errors.length);
  const best = ranked[0];
  if (!best || best.missing > 0 || best.errors.length === 0) return [{ path, message: `matches no ${what}` }];
  return best.errors;
}
