// Pure transform: monday board rows -> per-company client-safe payloads.
//
// No I/O and no network here on purpose, so the whitelist can be unit tested
// (scripts/transform.test.mjs) without a monday token.

export const BOARD_ID = '5029989258';

/** The only columns the build is ever allowed to read. */
export const COLUMNS = {
  company: 'color_mm5rb4n0',
  status: 'color_mm5b6g2w',
  station: 'single_selecti5qo0ki',
  required_by: 'datee00pzsmx',      // titled "Due by" on the board
  scheduled_date: 'date_mm5bh86t',
  delivered_date: 'date_mm5bx74j',
  deliverable_link: 'link_mm5bazhw',
  request_id: 'pulse_id_mm5btw1z',
};

/** Columns that must never reach a client payload, by id or by title. */
export const FORBIDDEN = [
  'emailacynbpqm',            // Email
  'long_textw1anfgaa',        // Description (internal notes, other people's emails)
  'multiple_person_mm5bcmx0', // Assigned surveyor
  'short_textiu99ld3y',       // Requested by
  'single_selectpy75o9v',     // Service type (internal classification)
  'single_selectdh7jkhm',     // Priority (internal)
  'short_texth6z2luh6',       // Location / Area
  'file1fxnt0m0',             // Supporting files
];

/** Exactly the keys a request object may carry. Anything else is a bug. */
export const ALLOWED_KEYS = [
  'request_id',
  'title',
  'status',
  'station',
  'required_by',
  'scheduled_date',
  'delivered_date',
  'deliverable_link',
  'closed',
];

/** Client-visible pipeline. "Closed" is rendered as complete/archived. */
export const STAGES = ['Submitted', 'Under review', 'Scheduled', 'In progress', 'Delivered'];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const isBlank = (v) => v === null || v === undefined || v === '';
const clean = (v) => (isBlank(v) ? null : String(v).trim() || null);

/**
 * Strip email addresses out of free text a client typed themselves.
 * Redacting rather than throwing keeps the 15 minute refresh alive: a stray
 * address in a request title must never publish an email, but it also must not
 * take the whole viewer offline. Structural problems still throw, below.
 */
function redactEmails(value, counter) {
  if (typeof value !== 'string') return value;
  return value.replace(EMAIL_RE, () => {
    counter.n += 1;
    return '[removed]';
  });
}

function columnMap(item) {
  const map = new Map();
  for (const cv of item.column_values ?? []) map.set(cv.id, cv);
  return map;
}

function linkUrl(cv) {
  if (!cv) return null;
  // monday link columns carry the href in `value`, not `text`.
  if (cv.value) {
    try {
      const url = clean(JSON.parse(cv.value)?.url);
      if (url && /^https?:\/\//i.test(url)) return url;
    } catch {
      /* fall through to text */
    }
  }
  const text = clean(cv.text);
  return text && /^https?:\/\//i.test(text) ? text : null;
}

/** Build one client-safe request object by explicit construction. */
export function toRequest(item, counter) {
  const cols = columnMap(item);
  const text = (key) => clean(cols.get(COLUMNS[key])?.text);
  const status = text('status');

  return {
    request_id: text('request_id') ?? String(item.id),
    title: redactEmails(clean(item.name) ?? 'Untitled request', counter),
    status,
    station: text('station'),
    required_by: text('required_by'),
    scheduled_date: text('scheduled_date'),
    delivered_date: text('delivered_date'),
    deliverable_link: linkUrl(cols.get(COLUMNS.deliverable_link)),
    closed: status === 'Closed' || status === 'Delivered',
  };
}

const stageIndex = (r) => {
  const i = STAGES.indexOf(r.status);
  return i === -1 ? 0 : i;
};

/** nulls always sort last, regardless of direction. */
function byDate(dir) {
  return (a, b) => {
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return dir === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
  };
}

export function sortRequests(requests) {
  const open = requests
    .filter((r) => !r.closed)
    .sort(
      (a, b) =>
        byDate('asc')(a.required_by, b.required_by) ||
        stageIndex(b) - stageIndex(a) ||
        a.title.localeCompare(b.title),
    );

  const done = requests
    .filter((r) => r.closed)
    .sort((a, b) => byDate('desc')(a.delivered_date, b.delivered_date) || a.title.localeCompare(b.title));

  return [...open, ...done];
}

/**
 * Fail the build on anything structural. These conditions cannot be produced by
 * client-entered data, only by a coding mistake, so throwing is correct.
 */
export function assertClean(payload) {
  const serialised = JSON.stringify(payload);

  for (const id of FORBIDDEN) {
    if (serialised.includes(id)) {
      throw new Error(`Payload for ${payload.company} contains forbidden column id "${id}"`);
    }
  }

  const found = serialised.match(EMAIL_RE);
  if (found) {
    throw new Error(`Payload for ${payload.company} contains an email address: ${found[0]}`);
  }

  const topLevel = Object.keys(payload).sort().join(',');
  if (topLevel !== 'company,generated_at,requests') {
    throw new Error(`Unexpected top level keys in payload: ${topLevel}`);
  }

  for (const r of payload.requests) {
    for (const key of Object.keys(r)) {
      if (!ALLOWED_KEYS.includes(key)) {
        throw new Error(`Request ${r.request_id} carries non-whitelisted key "${key}"`);
      }
    }
  }

  return payload;
}

/**
 * @param items    raw monday items (both groups)
 * @param tokenMap { "<url token>": "<Company label>" }
 * @returns Map<token, payload>
 */
export function buildPayloads(items, tokenMap, generatedAt) {
  const counter = { n: 0 };
  const byCompany = new Map();

  for (const item of items) {
    const company = clean(columnMap(item).get(COLUMNS.company)?.text);
    if (!company) continue;
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push(toRequest(item, counter));
  }

  const payloads = new Map();
  for (const [token, company] of Object.entries(tokenMap)) {
    payloads.set(
      token,
      assertClean({
        company,
        generated_at: generatedAt,
        // A configured company with no rows still gets a file, so its link never 404s.
        requests: sortRequests(byCompany.get(company) ?? []),
      }),
    );
  }

  return { payloads, redactions: counter.n };
}
