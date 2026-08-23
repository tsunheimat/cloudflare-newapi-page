import assert from 'node:assert/strict';
import test from 'node:test';

import { contentStatus } from '../public/static/content-meta.js';

test('content status metadata distinguishes validated live and fixture sources', () => {
  assert.deepEqual(
    contentStatus({
      source: 'newapi',
      fixture: false,
      live: true,
      label: 'NewAPI live content',
    }),
    {
      kind: 'live',
      label: 'NewAPI live content',
      badge: 'NewAPI · Live',
      sourceText: 'NewAPI（live）',
    },
  );
  assert.deepEqual(
    contentStatus({
      source: 'fixture',
      fixture: true,
      live: false,
      label: '演示价格数据',
    }),
    {
      kind: 'fixture',
      label: '演示价格数据',
      badge: 'Fixture · 非 live',
      sourceText: 'Fixture（非 live）',
    },
  );
});

test('content status metadata does not claim a source when flags disagree', () => {
  assert.equal(
    contentStatus({ source: 'newapi', fixture: true, live: true, label: 'bad' }).badge,
    'bad · 状态待确认',
  );
});
