# Creative Image Bridge

A small self-hosted **Remote MCP + REST** service that lets Claude (or another orchestrator) use OpenAI GPT Image as a campaign image engine while keeping your OpenAI API key on your server.

## What it gives you

- Remote MCP endpoint: `/mcp`
- Browser dashboard / Asset Vault: `/`
- REST API: `/api/*`
- OpenAI GPT Image 2.5 Flare for fast generation
- OpenAI GPT Image 2.5 Sunburst for quality/fidelity-sensitive edits
- Reference-image editing from stored `asset_id` values
- Exact advertising output sizes, including sizes the image API cannot generate natively
- Deterministic exact-asset compositing for logos/product cutouts
- Small campaign batch generation
- Persistent asset/output metadata on disk

## MCP tools

- `bridge_status`
- `list_assets`
- `get_asset`
- `generate_image`
- `edit_image`
- `generate_ad_visual`
- `make_format_variant`
- `compose_exact`
- `list_outputs`
- `get_output`
- `generate_campaign_batch`
- `plan_generation_size`

## 1. Local setup

Requirements: Node.js 22+.

```bash
cp .env.example .env
```

Edit `.env` and set at least:

```text
OPENAI_API_KEY=...
BRIDGE_API_KEY=...
```

Generate a strong bridge secret, for example:

```bash
openssl rand -hex 32
```

Then:

```bash
npm install
npm start
```

Open:

```text
http://localhost:8787
```

The dashboard lets you upload product/reference images and run a direct generation test.

## 2. Docker

```bash
cp .env.example .env
# edit .env
docker compose up --build
```

The named Docker volume keeps the Asset Vault and outputs between restarts.

## 3. Make it reachable by Claude

Claude web Custom Connectors call your MCP endpoint from Anthropic's cloud, so localhost alone is not enough. Deploy this container to any public HTTPS host that supports Node/Docker, or expose your local test server through a trusted HTTPS tunnel.

Your final MCP URL is:

```text
https://YOUR-DOMAIN/mcp
```

Keep `/mcp` protected with `BRIDGE_API_KEY`.

## 4. Add it to Claude

In Claude, add a Custom Connector and use:

- Name: `Creative Image Bridge`
- URL: `https://YOUR-DOMAIN/mcp`
- Authentication: `No sign in`
- Request header: `x-bridge-key` = the value of `BRIDGE_API_KEY`

Enable the connector for your campaign conversation/project.

Then add the contents of `CLAUDE_PROJECT_ADDENDUM.md` to your project instructions, or merge it with your existing Campaign Creative Studio prompt.

### First connector test

Ask Claude:

```text
Use Creative Image Bridge. Check bridge_status, then list_assets.
```

### First generation test

```text
Use Creative Image Bridge to generate a 1080x1350 photorealistic premium advertising background for a black hoodie campaign. No text or logos. Use Flare, medium quality.
```

## 5. Reference workflow

Upload a product/logo/reference in the dashboard. It receives an ID such as:

```text
asset_1790934000000_ab12cd34
```

Claude can then call `get_asset` to inspect it and `edit_image`/`generate_ad_visual` to use it as a reference.

For exact logos/artwork, do **not** rely on generative editing. Use `compose_exact` after generating the scene/background.

## 6. Why exact ad sizes work

GPT Image 2.5 custom source dimensions must satisfy API constraints (multiples of 16, supported pixel count and a 1:3–3:1 aspect ratio). Real ad formats often do not — for example 728x90.

The bridge:

1. calculates an API-valid source canvas;
2. generates/edits at that size;
3. post-processes to the exact requested final dimensions with Sharp.

For extreme ratios, ask for centered/compact subject placement and extendable negative space.

## 7. REST usage

The same server can be called without MCP.

```bash
curl https://YOUR-DOMAIN/api/generate \
  -H 'Content-Type: application/json' \
  -H 'x-bridge-key: YOUR_SECRET' \
  -d '{
    "prompt":"Premium top-down product advertising photography, no text",
    "model":"gpt-image-2.5-flare",
    "quality":"medium",
    "final_width":1080,
    "final_height":1350,
    "output_format":"png"
  }'
```

`openapi.yaml` is included for tool platforms that accept OpenAPI-based integrations.

## 8. Security notes

- Never put `OPENAI_API_KEY` into Claude project instructions or chats.
- Keep it only in server environment variables.
- Use a long independent `BRIDGE_API_KEY` for callers.
- Run behind HTTPS in production.
- Do not expose the data directory publicly.
- Rotate the bridge secret if you accidentally paste it into a public place.
- For a multi-user/team production deployment, replace the static shared secret with OAuth or per-user authentication and use durable object storage instead of local disk.

## 9. Current scope

This v1 is the **image engine**, not yet a full automated typography/layout renderer. It is intentionally strongest at:

- scene/background generation;
- reference-based visual creation/editing;
- product-oriented imagery;
- exact asset overlays;
- multi-format image adaptation.

Your Campaign Creative Studio layer should remain responsible for brand DNA, offers, angles, copy matrix, manifest and QA. A future v2 can add deterministic typography/layout templates and automatic campaign ZIP assembly.
