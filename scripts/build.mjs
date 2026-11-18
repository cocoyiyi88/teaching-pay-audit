import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { BRAND, BRAND_TITLE } from '../src/brand.js';

const root = resolve(import.meta.dirname, '..');
const source = resolve(root, 'src');
const output = resolve(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const firebase = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY || '',
  projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || '',
};

const config = `window.__AUDIT_GAJI_CONFIG__ = ${JSON.stringify({ firebase, brand: BRAND }, null, 2)};\n`;
await writeFile(resolve(output, 'config.js'), config, 'utf8');

const htmlPath = resolve(output, 'index.html');
const html = (await readFile(htmlPath, 'utf8'))
  .replaceAll('__APP_TITLE__', escapeHtml(BRAND_TITLE))
  .replaceAll('__APP_DESCRIPTION__', escapeHtml(BRAND.description));
await writeFile(htmlPath, html, 'utf8');

const manifestPath = resolve(output, 'manifest.webmanifest');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.name = BRAND_TITLE;
manifest.short_name = BRAND.appName;
manifest.description = BRAND.description;
manifest.lang = BRAND.locale;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const hash = createHash('sha256');
const files = (await readdir(output, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath ?? entry.path, entry.name))
  .sort();
for (const file of files) {
  const content = await readFile(file);
  hash.update(String(content.length)).update(':').update(content);
}
const worker = resolve(output, 'sw.js');
const workerSource = await readFile(worker, 'utf8');
await writeFile(worker, workerSource.replace('__BUILD_CACHE_ID__', hash.digest('hex').slice(0, 16)), 'utf8');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
console.log(`Build completed: ${output}`);
console.log(firebase.apiKey && firebase.projectId ? 'Firebase sign-in and cloud sync: enabled' : 'Firebase sign-in: disabled (environment variables are required for production)');
