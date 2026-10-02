import http from 'node:http';
import crypto from 'node:crypto';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { dashboardHtml } from './ui.js';
import { initStorage, saveAsset, listAssets, listOutputs, readAsset, readOutput, deleteAsset } from './storage.js';
import { generateImage, editImage, makeFormatVariant, composeExact } from './openai-images.js';
import { sourceSizeForTarget } from './image-sizes.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_MB || 40) * 1024 * 1024;
const MAX_BATCH = Math.max(1, Math.min(Number(process.env.MAX_BATCH_JOBS || 6), 12));

function expectedKey() {
  const k = process.env.BRIDGE_API_KEY;
  if (!k) throw new Error('BRIDGE_API_KEY is not configured.');
  return k;
}

function getPresentedKey(req) {
  const direct = req.headers['x-bridge-key'];
  if (typeof direct === 'string') return direct;
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : '';
}

function keyEquals(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  try { return keyEquals(getPresentedKey(req), expectedKey()); }
  catch { return false; }
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body, null, 2));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readJson(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BYTES) throw new Error(`JSON body too large. Limit is ${process.env.MAX_JSON_MB || 40} MB.`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function toolError(err) {
  return { content: [{ type: 'text', text: `ERROR: ${err.message}` }], isError: true };
}

function imageToolResult(result, note = '') {
  const first = result.outputs?.[0];
  const metadata = {
    outputs: result.outputs?.map(o => ({ id: o.record.id, label: o.record.label, mimeType: o.record.mimeType, bytes: o.record.bytes, metadata: o.record.metadata })),
    sizing: result.sizing,
    requestId: result.requestId || null,
    usage: result.usage || null
  };
  const content = [{ type: 'text', text: `${note ? note + '\n' : ''}${JSON.stringify(metadata, null, 2)}` }];
  if (first) content.push({ type: 'image', data: first.buffer.toString('base64'), mimeType: first.record.mimeType });
  return { content };
}

const imageModel = z.enum(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']).optional();
const quality = z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).optional();
const background = z.enum(['auto', 'opaque', 'transparent']).optional();
const outputFormat = z.enum(['png', 'jpeg', 'webp']).optional();
const postMode = z.enum(['cover', 'contain', 'blur-extend']).optional();

function createBridgeMcpServer() {
  const server = new McpServer({
    name: 'creative-image-bridge',
    version: '1.0.0'
  }, { capabilities: { tools: {} } });

  server.registerTool('bridge_status', {
    description: 'Check whether the Creative Image Bridge is online and see default models. Read-only.',
    inputSchema: z.object({})
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify({
    ok: true,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    defaultGenerateModel: process.env.DEFAULT_IMAGE_MODEL || 'gpt-image-2.5-flare',
    defaultEditModel: process.env.DEFAULT_EDIT_MODEL || 'gpt-image-2.5-sunburst',
    maxBatchJobs: MAX_BATCH
  }, null, 2) }] }));

  server.registerTool('list_assets', {
    description: 'List reference images, product cutouts, logos and other image assets already uploaded to the Asset Vault. Use the returned asset_id values in edit_image or generate_ad_visual.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() })
  }, async ({ limit }) => ({ content: [{ type: 'text', text: JSON.stringify(await listAssets(limit || 100), null, 2) }] }));

  server.registerTool('get_asset', {
    description: 'Inspect one Asset Vault image by asset_id. Returns the actual image plus metadata.',
    inputSchema: z.object({ asset_id: z.string() })
  }, async ({ asset_id }) => {
    try {
      const { record, buffer } = await readAsset(asset_id);
      return { content: [{ type: 'text', text: JSON.stringify(record, null, 2) }, { type: 'image', data: buffer.toString('base64'), mimeType: record.mimeType }] };
    } catch (e) { return toolError(e); }
  });

  server.registerTool('generate_image', {
    description: 'Generate a new advertising/source visual with OpenAI GPT Image. final_width/final_height may be exact ad dimensions; the bridge automatically chooses an API-valid source size and post-processes to the exact requested output.',
    inputSchema: z.object({
      prompt: z.string().min(1),
      model: imageModel,
      quality,
      final_width: z.number().int().min(64).max(6000).optional(),
      final_height: z.number().int().min(64).max(6000).optional(),
      background,
      output_format: outputFormat,
      post_process_mode: postMode,
      n: z.number().int().min(1).max(4).optional(),
      label: z.string().optional()
    })
  }, async (a) => {
    try { return imageToolResult(await generateImage({ prompt: a.prompt, model: a.model, quality: a.quality, finalWidth: a.final_width, finalHeight: a.final_height, background: a.background, outputFormat: a.output_format, postProcessMode: a.post_process_mode, n: a.n, label: a.label })); }
    catch (e) { return toolError(e); }
  });

  server.registerTool('edit_image', {
    description: 'Edit or generate from one or more reference images stored in the Asset Vault. Sunburst is recommended for fidelity-sensitive edits. Important: generative edits cannot guarantee pixel-exact logos/artwork; use compose_exact for exact overlays.',
    inputSchema: z.object({
      prompt: z.string().min(1),
      asset_ids: z.array(z.string()).min(1).max(10),
      mask_asset_id: z.string().optional(),
      model: imageModel,
      quality,
      final_width: z.number().int().min(64).max(6000).optional(),
      final_height: z.number().int().min(64).max(6000).optional(),
      background,
      output_format: outputFormat,
      post_process_mode: postMode,
      label: z.string().optional()
    })
  }, async (a) => {
    try { return imageToolResult(await editImage({ prompt: a.prompt, assetIds: a.asset_ids, maskAssetId: a.mask_asset_id, model: a.model, quality: a.quality, finalWidth: a.final_width, finalHeight: a.final_height, background: a.background, outputFormat: a.output_format, postProcessMode: a.post_process_mode, label: a.label })); }
    catch (e) { return toolError(e); }
  });

  server.registerTool('generate_ad_visual', {
    description: 'Create a campaign visual from structured marketing direction. If reference_asset_ids are supplied, uses image editing/reference mode. Designed for visual source imagery; final logos/prices/critical typography should normally be composited deterministically afterward.',
    inputSchema: z.object({
      campaign: z.string().optional(),
      offer: z.string(),
      angle: z.string().optional(),
      visual_direction: z.string(),
      brand_notes: z.string().optional(),
      must_keep: z.array(z.string()).optional(),
      avoid: z.array(z.string()).optional(),
      reference_asset_ids: z.array(z.string()).max(10).optional(),
      final_width: z.number().int().min(64).max(6000),
      final_height: z.number().int().min(64).max(6000),
      model: imageModel,
      quality,
      background,
      post_process_mode: postMode,
      label: z.string().optional()
    })
  }, async (a) => {
    const ratio = a.final_width / a.final_height;
    const safety = ratio > 3 || ratio < 1 / 3
      ? 'The final format is extremely narrow/tall. Keep the hero subject in a compact central safe zone and make the surrounding background easy to extend/crop.'
      : 'Compose specifically for the requested aspect ratio and preserve comfortable negative space.';
    const prompt = [
      'Create a polished advertising source visual. Do NOT add marketing copy, prices, CTA text, watermarks, or invented logos unless the user explicitly asks for text inside the visual.',
      a.campaign ? `Campaign: ${a.campaign}` : '',
      `Offer/product context: ${a.offer}`,
      a.angle ? `Creative angle: ${a.angle}` : '',
      `Visual direction: ${a.visual_direction}`,
      a.brand_notes ? `Brand DNA: ${a.brand_notes}` : '',
      a.must_keep?.length ? `Must preserve/keep: ${a.must_keep.join('; ')}` : '',
      a.avoid?.length ? `Avoid: ${a.avoid.join('; ')}` : '',
      `Final intended output: ${a.final_width}x${a.final_height}. ${safety}`,
      'If reference images are provided, use them according to the instructions; do not casually redesign distinctive product details.'
    ].filter(Boolean).join('\n\n');
    try {
      const refs = a.reference_asset_ids || [];
      const result = refs.length
        ? await editImage({ prompt, assetIds: refs, model: a.model || 'gpt-image-2.5-sunburst', quality: a.quality, finalWidth: a.final_width, finalHeight: a.final_height, background: a.background, postProcessMode: a.post_process_mode, outputFormat: 'png', label: a.label || `${a.offer} — ${a.angle || 'visual'}` })
        : await generateImage({ prompt, model: a.model, quality: a.quality, finalWidth: a.final_width, finalHeight: a.final_height, background: a.background, postProcessMode: a.post_process_mode, outputFormat: 'png', label: a.label || `${a.offer} — ${a.angle || 'visual'}` });
      return imageToolResult(result, `Production prompt:\n${prompt}`);
    } catch (e) { return toolError(e); }
  });

  server.registerTool('make_format_variant', {
    description: 'Create an exact-dimension format variant from an existing output or uploaded asset without another AI generation. Modes: cover, contain, blur-extend.',
    inputSchema: z.object({
      source_id: z.string(),
      source_kind: z.enum(['output', 'asset']).optional(),
      width: z.number().int().min(32).max(8000),
      height: z.number().int().min(32).max(8000),
      mode: postMode,
      output_format: outputFormat,
      label: z.string().optional()
    })
  }, async (a) => {
    try {
      const r = await makeFormatVariant({ sourceId: a.source_id, sourceKind: a.source_kind, width: a.width, height: a.height, mode: a.mode, outputFormat: a.output_format, label: a.label });
      return { content: [{ type: 'text', text: JSON.stringify(r.record, null, 2) }, { type: 'image', data: r.buffer.toString('base64'), mimeType: r.record.mimeType }] };
    } catch (e) { return toolError(e); }
  });

  server.registerTool('compose_exact', {
    description: 'Deterministically overlay original Asset Vault PNG/JPG assets (for example exact logos or product cutouts) over a base image. Unlike generative editing, this preserves the supplied pixel artwork apart from intentional scaling.',
    inputSchema: z.object({
      base_id: z.string(),
      base_kind: z.enum(['output', 'asset']).optional(),
      width: z.number().int().min(32).max(8000),
      height: z.number().int().min(32).max(8000),
      overlays: z.array(z.object({
        asset_id: z.string(),
        x_pct: z.number().min(-50).max(150),
        y_pct: z.number().min(-50).max(150),
        width_pct: z.number().min(1).max(200),
        opacity: z.number().min(0).max(1).optional()
      })).min(1).max(20),
      output_format: outputFormat,
      label: z.string().optional()
    })
  }, async (a) => {
    try {
      const r = await composeExact({ baseId: a.base_id, baseKind: a.base_kind, width: a.width, height: a.height, overlays: a.overlays.map(o => ({ assetId: o.asset_id, xPct: o.x_pct, yPct: o.y_pct, widthPct: o.width_pct, opacity: o.opacity })), outputFormat: a.output_format, label: a.label });
      return { content: [{ type: 'text', text: JSON.stringify(r.record, null, 2) }, { type: 'image', data: r.buffer.toString('base64'), mimeType: r.record.mimeType }] };
    } catch (e) { return toolError(e); }
  });

  server.registerTool('list_outputs', {
    description: 'List images created by the bridge and their output_id values.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() })
  }, async ({ limit }) => ({ content: [{ type: 'text', text: JSON.stringify(await listOutputs(limit || 100), null, 2) }] }));

  server.registerTool('get_output', {
    description: 'Inspect/retrieve an image previously created by the bridge using output_id.',
    inputSchema: z.object({ output_id: z.string() })
  }, async ({ output_id }) => {
    try {
      const { record, buffer } = await readOutput(output_id);
      return { content: [{ type: 'text', text: JSON.stringify(record, null, 2) }, { type: 'image', data: buffer.toString('base64'), mimeType: record.mimeType }] };
    } catch (e) { return toolError(e); }
  });

  server.registerTool('generate_campaign_batch', {
    description: `Generate a small batch of campaign visuals in one call (maximum ${MAX_BATCH}). Intended for controlled automation; for large campaigns call in batches to respect image API latency/rate limits.`,
    inputSchema: z.object({
      jobs: z.array(z.object({
        id: z.string(),
        prompt: z.string().min(1),
        reference_asset_ids: z.array(z.string()).max(10).optional(),
        final_width: z.number().int().min(64).max(6000),
        final_height: z.number().int().min(64).max(6000),
        model: imageModel,
        quality,
        background,
        post_process_mode: postMode
      })).min(1).max(MAX_BATCH)
    })
  }, async ({ jobs }) => {
    const summary = [];
    let firstPreview = null;
    for (const job of jobs) {
      try {
        const result = job.reference_asset_ids?.length
          ? await editImage({ prompt: job.prompt, assetIds: job.reference_asset_ids, model: job.model || 'gpt-image-2.5-sunburst', quality: job.quality, finalWidth: job.final_width, finalHeight: job.final_height, background: job.background, postProcessMode: job.post_process_mode, outputFormat: 'png', label: job.id })
          : await generateImage({ prompt: job.prompt, model: job.model, quality: job.quality, finalWidth: job.final_width, finalHeight: job.final_height, background: job.background, postProcessMode: job.post_process_mode, outputFormat: 'png', label: job.id });
        const out = result.outputs[0];
        summary.push({ job_id: job.id, status: 'ok', output_id: out.record.id, sizing: result.sizing });
        if (!firstPreview) firstPreview = out;
      } catch (e) {
        summary.push({ job_id: job.id, status: 'error', error: e.message });
      }
    }
    const content = [{ type: 'text', text: JSON.stringify({ jobs: summary }, null, 2) }];
    if (firstPreview) content.push({ type: 'image', data: firstPreview.buffer.toString('base64'), mimeType: firstPreview.record.mimeType });
    return { content };
  });

  server.registerTool('plan_generation_size', {
    description: 'Preview how the bridge maps an exact advertising format to an OpenAI Image API-compatible source canvas.',
    inputSchema: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), quality })
  }, async ({ width, height, quality: q }) => ({ content: [{ type: 'text', text: JSON.stringify(sourceSizeForTarget(width, height, q || 'medium'), null, 2) }] }));

  return server;
}

const mcpHandler = createMcpHandler(createBridgeMcpServer);
const mcpNodeHandler = toNodeHandler(mcpHandler);

async function handleApi(req, res, url) {
  if (!authorized(req)) return json(res, 401, { error: 'Unauthorized. Send x-bridge-key or Bearer token.' });

  if (req.method === 'GET' && url.pathname === '/api/assets') return json(res, 200, { assets: await listAssets() });
  if (req.method === 'POST' && url.pathname === '/api/assets') {
    const b = await readJson(req);
    if (!b.data_base64) return json(res, 400, { error: 'data_base64 is required' });
    const record = await saveAsset({ buffer: Buffer.from(b.data_base64, 'base64'), filename: b.filename || 'asset.png', mimeType: b.mime_type || 'image/png', label: b.label || '', tags: b.tags || [] });
    return json(res, 201, { asset: record });
  }
  const deleteAssetMatch = url.pathname.match(/^\/api\/assets\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteAssetMatch) return json(res, 200, { deleted: await deleteAsset(deleteAssetMatch[1]) });

  if (req.method === 'GET' && url.pathname === '/api/outputs') return json(res, 200, { outputs: await listOutputs() });
  const outputContentMatch = url.pathname.match(/^\/api\/outputs\/([^/]+)\/content$/);
  if (req.method === 'GET' && outputContentMatch) {
    const { record, buffer } = await readOutput(outputContentMatch[1]);
    res.writeHead(200, { 'Content-Type': record.mimeType, 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
    return res.end(buffer);
  }
  const assetContentMatch = url.pathname.match(/^\/api\/assets\/([^/]+)\/content$/);
  if (req.method === 'GET' && assetContentMatch) {
    const { record, buffer } = await readAsset(assetContentMatch[1]);
    res.writeHead(200, { 'Content-Type': record.mimeType, 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
    return res.end(buffer);
  }

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    const b = await readJson(req);
    const r = await generateImage({ prompt: b.prompt, model: b.model, quality: b.quality, background: b.background, outputFormat: b.output_format, finalWidth: b.final_width, finalHeight: b.final_height, postProcessMode: b.post_process_mode, n: b.n, label: b.label });
    return json(res, 200, { outputs: r.outputs.map(o => ({ id: o.record.id, ...o.record })), sizing: r.sizing, request_id: r.requestId, usage: r.usage });
  }
  if (req.method === 'POST' && url.pathname === '/api/edit') {
    const b = await readJson(req);
    const r = await editImage({ prompt: b.prompt, assetIds: b.asset_ids || [], maskAssetId: b.mask_asset_id, model: b.model, quality: b.quality, background: b.background, outputFormat: b.output_format, finalWidth: b.final_width, finalHeight: b.final_height, postProcessMode: b.post_process_mode, label: b.label });
    return json(res, 200, { outputs: r.outputs.map(o => ({ id: o.record.id, ...o.record })), sizing: r.sizing, request_id: r.requestId, usage: r.usage });
  }
  return json(res, 404, { error: 'Not found' });
}

await initStorage();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: true, service: 'creative-image-bridge', openaiConfigured: Boolean(process.env.OPENAI_API_KEY) });
    if (url.pathname === '/' && req.method === 'GET') {
      const body = Buffer.from(dashboardHtml);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      return res.end(body);
    }
    if (url.pathname === '/mcp') {
      if (!authorized(req)) return json(res, 401, { error: 'Unauthorized MCP request. Configure x-bridge-key.' });
      return void mcpNodeHandler(req, res);
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) return json(res, e?.status && Number.isInteger(e.status) ? e.status : 500, { error: e.message || 'Internal error', details: e.openai || undefined });
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.error(`Creative Image Bridge listening on http://${HOST}:${PORT}`);
  console.error(`MCP endpoint: /mcp`);
  console.error(`Dashboard: /`);
});

async function shutdown() {
  server.close();
  await mcpHandler.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
