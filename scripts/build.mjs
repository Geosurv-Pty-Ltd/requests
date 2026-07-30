// Reads the monday board and writes dist/ (the site plus one payload per company).
//
// Runs only inside GitHub Actions. Nothing it writes is ever committed: the
// workflow uploads dist/ straight to GitHub Pages, so the payload filenames
// (which are the client URL tokens) never appear in the public repo.

import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOARD_ID, COLUMNS, buildPayloads } from './transform.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const DIST = join(ROOT, 'dist');

const API = 'https://api.monday.com/v2';
const API_VERSION = '2024-10';
const PAGE_SIZE = 500;

/**
 * Reported and turned into a non-zero exit code by main(). Never calls
 * process.exit directly: a hard exit while a request socket is open aborts
 * noisily on some platforms and buries the real message.
 */
class BuildError extends Error {}
const fail = (message) => {
  throw new BuildError(message);
};

const FIELDS = `
  id
  name
  column_values(ids: ${JSON.stringify(Object.values(COLUMNS))}) {
    id
    text
    value
  }
`;

async function graphql(token, query, variables = {}) {
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
      'API-Version': API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`monday API returned HTTP ${res.status} ${res.statusText}`);

  const body = await res.json();
  if (body.errors?.length) {
    // Report only the messages. Never echo the request, which carries the token.
    throw new Error(`monday API error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  return body.data;
}

/** Every item on the board, from both the Active and Closed groups. */
async function fetchItems(token) {
  const first = await graphql(
    token,
    `query { boards(ids: [${BOARD_ID}]) { items_page(limit: ${PAGE_SIZE}) { cursor items { ${FIELDS} } } } }`,
  );

  const page = first.boards?.[0]?.items_page;
  if (!page) throw new Error(`board ${BOARD_ID} returned no items_page, check the token can see it`);

  const items = [...page.items];
  let cursor = page.cursor;

  while (cursor) {
    const next = await graphql(
      token,
      `query ($cursor: String!) { next_items_page(limit: ${PAGE_SIZE}, cursor: $cursor) { cursor items { ${FIELDS} } } }`,
      { cursor },
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  return items;
}

function readConfig() {
  const token = process.env.MONDAY_API_TOKEN;
  const raw = process.env.COMPANY_TOKENS;

  if (!token) fail('MONDAY_API_TOKEN is not set. Add it as a repository secret.');
  if (!raw) fail('COMPANY_TOKENS is not set. Add it as a repository secret.');

  let tokenMap;
  try {
    tokenMap = JSON.parse(raw);
  } catch {
    fail('COMPANY_TOKENS is not valid JSON. Expected {"<token>":"<Company label>"}.');
  }

  const entries = Object.entries(tokenMap);
  if (entries.length === 0) fail('COMPANY_TOKENS is empty.');
  for (const [companyToken, company] of entries) {
    if (!/^[a-f0-9]{32}$/.test(companyToken)) {
      fail(`COMPANY_TOKENS key for "${company}" must be 32 lowercase hex characters.`);
    }
  }

  return { token, tokenMap };
}

async function main() {
  const { token, tokenMap } = readConfig();

  let items;
  try {
    items = await fetchItems(token);
  } catch (err) {
    // Publish nothing. The previously deployed snapshot stays live, which is the
    // right outcome for a transient monday outage.
    fail(`Could not read the monday board: ${err.message}`);
  }

  const generatedAt = new Date().toISOString();
  const { payloads, redactions } = buildPayloads(items, tokenMap, generatedAt);

  // Belt and braces on top of assertClean: a token is a URL capability, so it
  // belongs in a filename and nowhere else. Guards against a future edit that
  // embeds it, or against the API token reaching a payload.
  const companyTokens = Object.keys(tokenMap);
  for (const payload of payloads.values()) {
    const body = JSON.stringify(payload);
    for (const t of companyTokens) {
      if (body.includes(t)) fail(`Payload for ${payload.company} contains a company token in its body.`);
    }
    if (body.includes(token)) fail(`Payload for ${payload.company} contains the monday API token.`);
  }

  await cp(SITE, DIST, { recursive: true });
  await mkdir(join(DIST, 'data'), { recursive: true });

  for (const [companyToken, payload] of payloads) {
    await writeFile(join(DIST, 'data', `${companyToken}.json`), JSON.stringify(payload), 'utf8');
    console.log(`  ${payload.company.padEnd(34)} ${String(payload.requests.length).padStart(3)} requests`);
  }

  console.log(`\n  ${items.length} board items read, ${payloads.size} payloads written, generated_at ${generatedAt}`);
  if (redactions) console.log(`  ${redactions} email address(es) redacted from request titles`);
}

try {
  await main();
} catch (err) {
  console.error(`\n  ${err instanceof BuildError ? err.message : `Unexpected failure: ${err.stack}`}\n`);
  process.exitCode = 1;
}
