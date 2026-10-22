// Listing snapshot/paging and git queries (C3, E11, E12).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryGit, createMemoryList } from '../src/index.ts';

test('a 10k-path listing stays inside quota and pages (E11)', async () => {
  const files = Array.from({ length: 10_000 }, (_, i) => ({ path: `f/${i}.txt`, bytes: 1, directory: false }));
  const list = createMemoryList({ files, snapshotId: 'snap' });
  const page = await list.list('p', { offset: 0, limit: 256 });
  assert.equal(page.status, 'ok');
  assert.equal(page.total, 10_000);
  assert.equal(page.entries?.length, 256);
  assert.equal(page.snapshotId, 'snap');
});

test('git queries return branch, status, log and changed paths (E12)', async () => {
  const git = createMemoryGit({
    branch: 'main',
    dirty: true,
    subjects: ['one', 'two'],
    paths: ['a.ts'],
  });
  assert.equal((await git.query({ kind: 'branch' })).branch, 'main');
  assert.equal((await git.query({ kind: 'status' })).dirty, true);
  assert.deepEqual((await git.query({ kind: 'log', limit: 1 })).subjects, ['one']);
  assert.deepEqual((await git.query({ kind: 'changed' })).paths, ['a.ts']);
});
