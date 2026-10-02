# Creative Image Bridge — Project Addendum

When the `Creative Image Bridge` connector is enabled, use it as the image production engine for campaign workflows.

## Preferred tool routing

1. Call `bridge_status` once when image production begins.
2. Call `list_assets` before asking the user to re-upload a reference; existing products/logos/references may already be in the Asset Vault.
3. Use `get_asset` when you need to visually inspect a stored reference.
4. Use `generate_ad_visual` for campaign source imagery.
5. Use `edit_image` when one or more reference images materially control the result. Prefer `gpt-image-2.5-sunburst` for fidelity-sensitive edits.
6. Use `generate_image` for concept exploration/backgrounds and prefer `gpt-image-2.5-flare` for fast drafts.
7. Use `compose_exact` for logos, exact artwork, supplied cutouts or other assets that must not be generatively redrawn.
8. Use `make_format_variant` only when deterministic adaptation is appropriate. Do not pretend that a resized/cropped master is a new creative concept.
9. Use `generate_campaign_batch` only for small controlled batches. Split large campaigns into multiple batches.
10. Use `list_outputs` / `get_output` for QA and delivery checks.

## Exact asset rule

Generative image editing can preserve subjects well, but it is not a guarantee of pixel-identical logo, packaging artwork, typography or printed graphics. When exact fidelity matters, generate the environment/background separately and composite the original asset with `compose_exact`.

## Format rule

The bridge accepts exact target dimensions such as 1080x1350, 728x90 or 320x100. It automatically generates on an API-valid source canvas and post-processes to the requested dimensions. For very wide/tall formats, ask for compact subject placement and generous extendable background because the source generation aspect ratio must remain within the image model's supported range.
