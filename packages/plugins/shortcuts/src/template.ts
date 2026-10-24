// Starter files. Single-quoted strings only, `;`-prefixed names, version = 1
// (02-architecture § File format). `murmo init` writes the project one;
// `murmo setup` and `murmo init --user` write the personal one, which also
// shows the switches only a personal file may turn on.

export const INIT_TEMPLATE = `\
version = 1
# Shortcuts expand when you type them and then a space. Backspace right after undoes.
# Use single quotes: '…' and '''…''' keep backslashes and quotes exactly.
[replace]
";tst" = 'Run the test suite, fix failures, and do not edit the tests.'
";rvw" = '''
Review this change for bugs, edge cases and missing tests.
List issues by severity. Be concise.
'''
# Templates: lowercase <field> placeholders; a field with a default shows it.
# In Pi and OpenCode, Tab moves between fields; elsewhere edit them by hand.
# Enter with a field still unfilled warns once; Enter again sends anyway.
# [replace.";review"]
# text = '''
# Review <change> for correctness.
# Pay particular attention to <concern>.
# '''
# description = "Code review request"
# fields.change = { default = "this change" }
`;

export const USER_TEMPLATE = `${INIT_TEMPLATE}
# Autocorrect fixes known typos as you finish a word (teh -> the). It is off
# until you turn it on here; Backspace right after a fix undoes it.
# [autocorrect]
# enabled = true

# Words autocorrect never changes. \`murmo words add <word>\` adds to a list too.
# [words]
# protect = ["Kubernetes"]
`;
