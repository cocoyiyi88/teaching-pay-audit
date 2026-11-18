import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

test('vercel.json disables HTTP caching on HTML entry points so CSP updates are never stuck behind 304 responses', async () => {
  const config = JSON.parse(await readFile(resolve(root, 'vercel.json'), 'utf8'));
  const headersBySource = new Map((config.headers || []).map((rule) => [rule.source, rule.headers || []]));

  for (const entry of ['/', '/index.html']) {
    const entryHeaders = headersBySource.get(entry) || [];
    assert.ok(
      entryHeaders.some((item) => item.key === 'Cache-Control' && /no-store/i.test(item.value)),
      `Expected Cache-Control: no-store for ${entry}`,
    );
  }

  const globalHeaders = headersBySource.get('/(.*)') || [];
  const csp = globalHeaders.find((item) => item.key === 'Content-Security-Policy')?.value || '';
  assert.match(csp, /https:\/\/zen\.charisna-superapp\.workers\.dev/);
});

test('service worker reloads shell assets during install and bypasses HTTP cache on document navigations', async () => {
  const sw = await readFile(resolve(root, 'src/sw.js'), 'utf8');
  assert.match(sw, /new Request\(url,\s*\{\s*cache:\s*'reload'\s*\}\)/);
  assert.match(sw, /event\.request\.mode === 'navigate'/);
  assert.match(sw, /cache:\s*'no-store'/);
});

test('build script injects the same build hash (including vercel.json) into dist/index.html and dist/sw.js', async () => {
  const buildScript = await readFile(resolve(root, 'scripts/build.mjs'), 'utf8');
  assert.match(buildScript, /vercel\.json/);

  execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { cwd: root, stdio: 'pipe' });
  const distHtml = await readFile(resolve(root, 'dist/index.html'), 'utf8');
  const distSw = await readFile(resolve(root, 'dist/sw.js'), 'utf8');

  const htmlMatch = distHtml.match(/<meta name="app-build" content="([a-f0-9]{16})">/);
  const swMatch = distSw.match(/const CACHE = CACHE_PREFIX \+ '([a-f0-9]{16})';/);
  assert.ok(htmlMatch, 'dist/index.html must include a 16-char hex app-build meta tag');
  assert.ok(swMatch, 'dist/sw.js must include a 16-char hex cache ID');
  assert.equal(htmlMatch[1], swMatch[1]);
});
