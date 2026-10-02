import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
const ASSET_INDEX = path.join(DATA_DIR, 'assets.json');
const OUTPUT_INDEX = path.join(DATA_DIR, 'outputs.json');

export async function initStorage() {
  await fs.mkdir(ASSET_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await ensureJson(ASSET_INDEX, []);
  await ensureJson(OUTPUT_INDEX, []);
}

async function ensureJson(file, fallback) {
  try { await fs.access(file); }
  catch { await fs.writeFile(file, JSON.stringify(fallback, null, 2)); }
}

async function readIndex(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return []; }
}

async function writeIndex(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

function cleanName(name = 'file') {
  return String(name)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'file';
}

function extensionForMime(mime) {
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/svg+xml') return 'svg';
  return 'png';
}

export async function saveAsset({ buffer, filename, mimeType, label = '', tags = [] }) {
  const id = `asset_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const ext = path.extname(filename || '')?.replace('.', '') || extensionForMime(mimeType);
  const storedName = `${id}_${cleanName(path.basename(filename || `asset.${ext}`, path.extname(filename || '')))}.${ext}`;
  const filePath = path.join(ASSET_DIR, storedName);
  await fs.writeFile(filePath, buffer);

  const record = {
    id,
    filename: filename || storedName,
    storedName,
    mimeType,
    label,
    tags: Array.isArray(tags) ? tags : [],
    bytes: buffer.length,
    createdAt: new Date().toISOString()
  };
  const index = await readIndex(ASSET_INDEX);
  index.unshift(record);
  await writeIndex(ASSET_INDEX, index);
  return record;
}

export async function saveOutput({ buffer, mimeType = 'image/png', label = '', metadata = {} }) {
  const id = `out_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const ext = extensionForMime(mimeType);
  const storedName = `${id}.${ext}`;
  const filePath = path.join(OUTPUT_DIR, storedName);
  await fs.writeFile(filePath, buffer);
  const record = {
    id,
    storedName,
    mimeType,
    label,
    bytes: buffer.length,
    createdAt: new Date().toISOString(),
    metadata
  };
  const index = await readIndex(OUTPUT_INDEX);
  index.unshift(record);
  await writeIndex(OUTPUT_INDEX, index);
  return record;
}

export async function listAssets(limit = 100) {
  return (await readIndex(ASSET_INDEX)).slice(0, limit);
}

export async function listOutputs(limit = 100) {
  return (await readIndex(OUTPUT_INDEX)).slice(0, limit);
}

export async function getAssetRecord(id) {
  return (await readIndex(ASSET_INDEX)).find(x => x.id === id) || null;
}

export async function getOutputRecord(id) {
  return (await readIndex(OUTPUT_INDEX)).find(x => x.id === id) || null;
}

export async function readAsset(id) {
  const record = await getAssetRecord(id);
  if (!record) throw new Error(`Unknown asset_id: ${id}`);
  return { record, buffer: await fs.readFile(path.join(ASSET_DIR, record.storedName)) };
}

export async function readOutput(id) {
  const record = await getOutputRecord(id);
  if (!record) throw new Error(`Unknown output_id: ${id}`);
  return { record, buffer: await fs.readFile(path.join(OUTPUT_DIR, record.storedName)) };
}

export async function deleteAsset(id) {
  const index = await readIndex(ASSET_INDEX);
  const pos = index.findIndex(x => x.id === id);
  if (pos < 0) return false;
  const [record] = index.splice(pos, 1);
  await fs.rm(path.join(ASSET_DIR, record.storedName), { force: true });
  await writeIndex(ASSET_INDEX, index);
  return true;
}
