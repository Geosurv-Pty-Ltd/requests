import test from 'node:test';
import assert from 'node:assert/strict';

import { COLUMNS, buildPayloads, sortRequests, assertClean, toRequest } from './transform.mjs';

const GAMUDA = 'tokentokentokentokentokentokento';
const JH = 'aaaabbbbccccddddeeeeffff00001111';
const NOW = '2026-07-30T04:00:00.000Z';

/** Build a raw monday item the way the API returns one. */
function item({ id, name, company, status, station, due, sched, delivered, link, by = null, extra = [] }) {
  const cv = (colKey, text, value = null) => ({ id: COLUMNS[colKey], text, value });
  return {
    id,
    name,
    column_values: [
      cv('company', company),
      cv('status', status),
      cv('station', station),
      cv('required_by', due),
      cv('scheduled_date', sched),
      cv('delivered_date', delivered),
      cv('deliverable_link', link ? 'Open in ACC' : null, link ? JSON.stringify({ url: link, text: 'Open in ACC' }) : null),
      cv('request_id', id),
      cv('requested_by', by),
      ...extra,
    ],
  };
}

const GAMUDA_ROW = item({
  id: '2809849865',
  name: 'Marking up Station Ground Support Anchors',
  company: 'Gamuda',
  status: 'In progress',
  station: 'TBY',
  due: '2026-08-04',
  sched: '2026-08-01',
  delivered: null,
  link: null,
  by: 'Hanna Shehwaro',
});

const JH_ROW = item({
  id: '999000111',
  name: 'John Holland set-out',
  company: 'John Holland',
  status: 'Submitted',
  station: 'FDK',
  due: '2026-08-09',
  sched: null,
  delivered: null,
  link: null,
});

test('a payload carries only the whitelisted keys', () => {
  const { payloads } = buildPayloads([GAMUDA_ROW], { [GAMUDA]: 'Gamuda' }, NOW);
  const req = payloads.get(GAMUDA).requests[0];

  assert.deepEqual(Object.keys(req).sort(), [
    'closed',
    'deliverable_link',
    'delivered_date',
    'request_id',
    'requested_by',
    'required_by',
    'scheduled_date',
    'station',
    'status',
    'title',
  ].sort());

  assert.equal(req.request_id, '2809849865');
  assert.equal(req.status, 'In progress');
  assert.equal(req.closed, false);
  assert.equal(req.requested_by, 'Hanna Shehwaro');
});

test('excluded columns are dropped even when the API returns them', () => {
  const leaky = item({
    id: '1',
    name: 'Leaky row',
    company: 'Gamuda',
    status: 'Submitted',
    station: 'TBY',
    due: null,
    sched: null,
    delivered: null,
    link: null,
    extra: [
      { id: 'emailacynbpqm', text: 'ZiaSamano@gamuda.com.au', value: null },
      { id: 'long_textw1anfgaa', text: 'Internal note, contact FatemaShukur@gamuda.com.au', value: null },
      { id: 'multiple_person_mm5bcmx0', text: 'Jordan Palleson', value: null },
      { id: 'single_selectpy75o9v', text: 'Utility Locating', value: null },
      { id: 'single_selectdh7jkhm', text: 'Urgent', value: null },
    ],
  });

  const { payloads } = buildPayloads([leaky], { [GAMUDA]: 'Gamuda' }, NOW);
  const serialised = JSON.stringify(payloads.get(GAMUDA));

  assert.doesNotMatch(serialised, /@/);
  assert.doesNotMatch(serialised, /gamuda\.com\.au/i);
  assert.doesNotMatch(serialised, /Jordan Palleson/);
  assert.doesNotMatch(serialised, /Internal note/);
  assert.doesNotMatch(serialised, /Utility Locating/);
  assert.doesNotMatch(serialised, /Urgent/);
  for (const id of ['emailacynbpqm', 'long_textw1anfgaa', 'multiple_person_mm5bcmx0',
                    'single_selectpy75o9v', 'single_selectdh7jkhm']) {
    assert.ok(!serialised.includes(id), `${id} leaked`);
  }
});

test('an email typed into Requested by is redacted, not published', () => {
  const row = item({
    id: '7',
    name: 'Culvert pickup',
    company: 'Gamuda',
    status: 'Submitted',
    station: 'TBY',
    due: null,
    sched: null,
    delivered: null,
    link: null,
    by: 'Hanna Shehwaro HannaShehwaro@gamuda.com.au',
  });

  const { payloads, redactions } = buildPayloads([row], { [GAMUDA]: 'Gamuda' }, NOW);
  assert.equal(redactions, 1);
  assert.equal(payloads.get(GAMUDA).requests[0].requested_by, 'Hanna Shehwaro [removed]');
});

test('one company never sees another company rows', () => {
  const { payloads } = buildPayloads([GAMUDA_ROW, JH_ROW], { [GAMUDA]: 'Gamuda', [JH]: 'John Holland' }, NOW);

  const gamuda = JSON.stringify(payloads.get(GAMUDA));
  assert.ok(!gamuda.includes('John Holland'));
  assert.equal(payloads.get(GAMUDA).requests.length, 1);

  const jh = JSON.stringify(payloads.get(JH));
  assert.ok(!jh.includes('Station Ground Support Anchors'));
  assert.equal(payloads.get(JH).requests.length, 1);
});

test('an email typed into a request title is redacted, not published', () => {
  const row = item({
    id: '2',
    name: 'Setout for ZiaSamano@gamuda.com.au please',
    company: 'Gamuda',
    status: 'Submitted',
    station: 'TBY',
    due: null,
    sched: null,
    delivered: null,
    link: null,
  });

  const { payloads, redactions } = buildPayloads([row], { [GAMUDA]: 'Gamuda' }, NOW);
  assert.equal(redactions, 1);
  assert.equal(payloads.get(GAMUDA).requests[0].title, 'Setout for [removed] please');
});

test('a configured company with no rows still gets an empty payload', () => {
  const { payloads } = buildPayloads([GAMUDA_ROW], { [GAMUDA]: 'Gamuda', [JH]: 'John Holland' }, NOW);
  assert.deepEqual(payloads.get(JH).requests, []);
  assert.equal(payloads.get(JH).company, 'John Holland');
});

test('deliverable link is taken from value, and only when it is a real url', () => {
  const withLink = item({
    id: '3',
    name: 'Delivered job',
    company: 'Gamuda',
    status: 'Delivered',
    station: 'TBY',
    due: null,
    sched: null,
    delivered: '2026-07-23',
    link: 'https://acc.autodesk.com/docs/files/projects/abc',
  });
  const [req] = buildPayloads([withLink], { [GAMUDA]: 'Gamuda' }, NOW).payloads.get(GAMUDA).requests;
  assert.equal(req.deliverable_link, 'https://acc.autodesk.com/docs/files/projects/abc');
  assert.equal(req.closed, true);

  const notAUrl = { ...withLink, id: '4' };
  notAUrl.column_values = withLink.column_values.map((cv) =>
    cv.id === COLUMNS.deliverable_link ? { id: cv.id, text: 'In ACC somewhere', value: null } : cv,
  );
  const [plain] = buildPayloads([notAUrl], { [GAMUDA]: 'Gamuda' }, NOW).payloads.get(GAMUDA).requests;
  assert.equal(plain.deliverable_link, null);
});

test('open work sorts before completed work, by due date with blanks last', () => {
  const mk = (title, status, due, delivered) => ({
    request_id: title,
    title,
    status,
    station: 'TBY',
    required_by: due,
    scheduled_date: null,
    delivered_date: delivered,
    deliverable_link: null,
    closed: status === 'Delivered' || status === 'Closed',
  });

  const sorted = sortRequests([
    mk('old delivery', 'Closed', null, '2026-06-01'),
    mk('no due date', 'Submitted', null, null),
    mk('due later', 'Submitted', '2026-09-01', null),
    mk('due soon', 'In progress', '2026-08-01', null),
    mk('recent delivery', 'Delivered', null, '2026-07-23'),
  ]).map((r) => r.title);

  assert.deepEqual(sorted, ['due soon', 'due later', 'no due date', 'recent delivery', 'old delivery']);
});

test('assertClean throws on a non-whitelisted key', () => {
  assert.throws(
    () =>
      assertClean({
        company: 'Gamuda',
        generated_at: NOW,
        requests: [{ request_id: '1', title: 'x', internal_note: 'oops' }],
      }),
    /non-whitelisted key "internal_note"/,
  );
});

test('assertClean throws on an unexpected top level key', () => {
  assert.throws(
    () => assertClean({ company: 'Gamuda', generated_at: NOW, requests: [], token: 'leak' }),
    /Unexpected top level keys/,
  );
});

test('toRequest falls back to the item id when the mirror column is empty', () => {
  const noMirror = {
    id: '555',
    name: 'No mirror',
    column_values: [{ id: COLUMNS.status, text: 'Submitted', value: null }],
  };
  const req = toRequest(noMirror, { n: 0 });
  assert.equal(req.request_id, '555');
  assert.equal(req.station, null);
});
