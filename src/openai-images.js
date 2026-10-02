import sharp from 'sharp';
import { sourceSizeForTarget, parseSize } from './image-sizes.js';
import { readAsset, readOutput, saveOutput } from './storage.js';

const OPENAI_URL = 'https://api.openai.com/v1';

function requireOpenAIKey() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not configured on the bridge server.');
  return key;
}

function mimeForFormat(format) {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

function normalizeModel(model, edit = false) {
  return model || (edit
    ? process.env.DEFAULT_EDIT_MODEL || 'gpt-image-2.5-sunburst'
    : process.env.DEFAULT_IMAGE_MODEL || 'gpt-image-2.5-flare');
}

function ensureFormatForBackground(outputFormat, background) {
  if (background === 'transparent' && outputFormat === 'jpeg') return 'png';
  return outputFormat;
}

async function parseOpenAIError(response) {
  let body;
  try { body = await response.json(); }
  catch { body = { error: { message: await response.text().catch(() => '') } }; }
  const message = body?.error?.message || `OpenAI API request failed with HTTP ${response.status}`;
  const err = new Error(message);
  err.status = response.status;
  err.openai = body;
  return err;
}

async function postProcess(buffer, { targetWidth, targetHeight, outputFormat, mode = 'cover' }) {
  if (!targetWidth || !targetHeight) return buffer;
  let pipeline = sharp(buffer, { failOn: 'none' });

  if (mode === 'blur-extend') {
    const background = await sharp(buffer)
      .resize(targetWidth, targetHeight, { fit: 'cover', position: 'centre' })
      .blur(Math.max(8, Math.round(Math.min(targetWidth, targetHeight) / 45)))
      .toBuffer();
    const foreground = await sharp(buffer)
      .resize(targetWidth, targetHeight, { fit: 'contain', withoutEnlargement: false })
      .toBuffer();
    pipeline = sharp(background).composite([{ input: foreground, gravity: 'centre' }]);
  } else {
    pipeline = pipeline.resize(targetWidth, targetHeight, {
      fit: mode === 'contain' ? 'contain' : 'cover',
      position: 'centre',
      background: { r: 255, g: 255, b: 255, alpha: 0 }
    });
  }

  if (outputFormat === 'jpeg') return pipeline.jpeg({ quality: 94 }).toBuffer();
  if (outputFormat === 'webp') return pipeline.webp({ quality: 95 }).toBuffer();
  return pipeline.png().toBuffer();
}

export async function generateImage(options) {
  const {
    prompt,
    model,
    quality = process.env.DEFAULT_QUALITY || 'medium',
    background = 'auto',
    outputFormat: requestedFormat = 'png',
    outputCompression,
    n = 1,
    finalWidth,
    finalHeight,
    apiSize,
    postProcessMode = 'cover',
    label = ''
  } = options;

  if (!prompt?.trim()) throw new Error('prompt is required');
  let outputFormat = ensureFormatForBackground(requestedFormat, background);
  const target = finalWidth && finalHeight ? { width: finalWidth, height: finalHeight } : parseSize(apiSize || '1024x1024');
  const sizing = finalWidth && finalHeight
    ? sourceSizeForTarget(finalWidth, finalHeight, quality)
    : { apiSize: apiSize || `${target.width}x${target.height}`, needsPostProcess: false, targetWidth: target.width, targetHeight: target.height, ratioWasClamped: false };

  const payload = {
    model: normalizeModel(model, false),
    prompt,
    size: sizing.apiSize,
    quality,
    background,
    output_format: outputFormat,
    n: Math.min(Math.max(Number(n) || 1, 1), 10)
  };
  if (outputCompression != null && ['jpeg', 'webp'].includes(outputFormat)) {
    payload.output_compression = Number(outputCompression);
  }

  const response = await fetch(`${OPENAI_URL}/images/generations`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireOpenAIKey()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw await parseOpenAIError(response);
  const json = await response.json();
  const requestId = response.headers.get('x-request-id');

  const outputs = [];
  for (let i = 0; i < (json.data || []).length; i++) {
    const raw = Buffer.from(json.data[i].b64_json, 'base64');
    const finalBuffer = sizing.needsPostProcess
      ? await postProcess(raw, { targetWidth: finalWidth, targetHeight: finalHeight, outputFormat, mode: postProcessMode })
      : raw;
    const record = await saveOutput({
      buffer: finalBuffer,
      mimeType: mimeForFormat(outputFormat),
      label: label || `Generated image ${i + 1}`,
      metadata: {
        operation: 'generate',
        prompt,
        model: payload.model,
        quality,
        background,
        apiSize: sizing.apiSize,
        finalWidth: finalWidth || null,
        finalHeight: finalHeight || null,
        ratioWasClamped: !!sizing.ratioWasClamped,
        openaiRequestId: requestId
      }
    });
    outputs.push({ record, buffer: finalBuffer });
  }
  return { outputs, sizing, requestId, usage: json.usage || null };
}

export async function editImage(options) {
  const {
    prompt,
    assetIds = [],
    maskAssetId,
    model,
    quality = process.env.DEFAULT_QUALITY || 'medium',
    background = 'auto',
    outputFormat: requestedFormat = 'png',
    outputCompression,
    finalWidth,
    finalHeight,
    apiSize,
    postProcessMode = 'cover',
    label = ''
  } = options;
  if (!prompt?.trim()) throw new Error('prompt is required');
  if (!assetIds.length) throw new Error('At least one asset_id is required for edit_image.');

  let outputFormat = ensureFormatForBackground(requestedFormat, background);
  const sizing = finalWidth && finalHeight
    ? sourceSizeForTarget(finalWidth, finalHeight, quality)
    : { apiSize: apiSize || '1024x1024', needsPostProcess: false, targetWidth: finalWidth, targetHeight: finalHeight, ratioWasClamped: false };

  const form = new FormData();
  form.set('model', normalizeModel(model, true));
  form.set('prompt', prompt);
  form.set('size', sizing.apiSize);
  form.set('quality', quality);
  form.set('background', background);
  form.set('output_format', outputFormat);
  if (outputCompression != null && ['jpeg', 'webp'].includes(outputFormat)) {
    form.set('output_compression', String(outputCompression));
  }

  for (const assetId of assetIds) {
    const { record, buffer } = await readAsset(assetId);
    form.append('image[]', new Blob([buffer], { type: record.mimeType }), record.filename || `${assetId}.png`);
  }
  if (maskAssetId) {
    const { record, buffer } = await readAsset(maskAssetId);
    form.set('mask', new Blob([buffer], { type: record.mimeType }), record.filename || `${maskAssetId}.png`);
  }

  const response = await fetch(`${OPENAI_URL}/images/edits`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireOpenAIKey()}` },
    body: form
  });
  if (!response.ok) throw await parseOpenAIError(response);
  const json = await response.json();
  const requestId = response.headers.get('x-request-id');
  const outputs = [];
  for (let i = 0; i < (json.data || []).length; i++) {
    const raw = Buffer.from(json.data[i].b64_json, 'base64');
    const finalBuffer = sizing.needsPostProcess
      ? await postProcess(raw, { targetWidth: finalWidth, targetHeight: finalHeight, outputFormat, mode: postProcessMode })
      : raw;
    const record = await saveOutput({
      buffer: finalBuffer,
      mimeType: mimeForFormat(outputFormat),
      label: label || `Edited image ${i + 1}`,
      metadata: {
        operation: 'edit',
        prompt,
        assetIds,
        maskAssetId: maskAssetId || null,
        model: normalizeModel(model, true),
        quality,
        background,
        apiSize: sizing.apiSize,
        finalWidth: finalWidth || null,
        finalHeight: finalHeight || null,
        ratioWasClamped: !!sizing.ratioWasClamped,
        openaiRequestId: requestId
      }
    });
    outputs.push({ record, buffer: finalBuffer });
  }
  return { outputs, sizing, requestId, usage: json.usage || null };
}

export async function makeFormatVariant({ sourceId, sourceKind = 'output', width, height, mode = 'cover', outputFormat = 'png', label = '' }) {
  const source = sourceKind === 'asset' ? await readAsset(sourceId) : await readOutput(sourceId);
  const finalBuffer = await postProcess(source.buffer, {
    targetWidth: width,
    targetHeight: height,
    outputFormat,
    mode
  });
  const record = await saveOutput({
    buffer: finalBuffer,
    mimeType: mimeForFormat(outputFormat),
    label: label || `${sourceId} ${width}x${height}`,
    metadata: { operation: 'format-variant', sourceId, sourceKind, width, height, mode }
  });
  return { record, buffer: finalBuffer };
}

export async function composeExact({ baseId, baseKind = 'output', width, height, overlays = [], outputFormat = 'png', label = '' }) {
  const base = baseKind === 'asset' ? await readAsset(baseId) : await readOutput(baseId);
  let canvas = await sharp(base.buffer)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  const composite = [];
  for (const item of overlays) {
    const { buffer } = await readAsset(item.assetId);
    const targetWidth = Math.max(1, Math.round(width * (item.widthPct / 100)));
    let overlayPipeline = sharp(buffer)
      .resize({ width: targetWidth, withoutEnlargement: false })
      .ensureAlpha();
    if (item.opacity != null && Number(item.opacity) < 1) {
      const opacity = Math.max(0, Math.min(1, Number(item.opacity)));
      overlayPipeline = overlayPipeline.linear([1, 1, 1, opacity], [0, 0, 0, 0]);
    }
    const resized = await overlayPipeline.toBuffer();
    const meta = await sharp(resized).metadata();
    const left = Math.round(width * (item.xPct / 100) - (meta.width || targetWidth) / 2);
    const top = Math.round(height * (item.yPct / 100) - (meta.height || 1) / 2);
    composite.push({ input: resized, left: Math.max(-targetWidth, left), top: Math.max(-(meta.height || 1), top) });
  }

  let out = sharp(canvas).composite(composite);
  if (outputFormat === 'jpeg') out = out.jpeg({ quality: 94 });
  else if (outputFormat === 'webp') out = out.webp({ quality: 95 });
  else out = out.png();
  const finalBuffer = await out.toBuffer();
  const record = await saveOutput({
    buffer: finalBuffer,
    mimeType: mimeForFormat(outputFormat),
    label: label || `Composite ${width}x${height}`,
    metadata: { operation: 'compose-exact', baseId, baseKind, width, height, overlays }
  });
  return { record, buffer: finalBuffer };
}
