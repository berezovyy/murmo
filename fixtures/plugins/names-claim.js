// Consumes Tab only at a code-like word (phase 36 `at-code-like-word`).

export default () => ({
  name: 'names-claim',
  version: '1.0.0',
  permissions: [],
  keys: [{ key: 'Tab', when: ['editable', 'at-code-like-word'], action: 'dispatch', consume: true }],
});
