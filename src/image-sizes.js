const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_EDGE = 3840;
const MIN_RATIO = 1 / 3;
const MAX_RATIO = 3;

function round16(n) {
  return Math.max(16, Math.round(n / 16) * 16);
}

function floor16(n) {
  return Math.max(16, Math.floor(n / 16) * 16);
}

export function parseSize(size) {
  if (!size || size === 'auto') return null;
  const m = String(size).trim().match(/^(\d+)x(\d+)$/i);
  if (!m) throw new Error(`Invalid size '${size}'. Expected WIDTHxHEIGHT.`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function isValidApiSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
  if (width <= 0 || height <= 0) return false;
  if (width % 16 !== 0 || height % 16 !== 0) return false;
  if (width > MAX_EDGE || height > MAX_EDGE) return false;
  const ratio = width / height;
  if (ratio < MIN_RATIO || ratio > MAX_RATIO) return false;
  const pixels = width * height;
  return pixels >= MIN_PIXELS && pixels <= MAX_PIXELS;
}

/**
 * Convert any advertising output dimension into an API-valid source canvas.
 * The generated canvas preserves the requested ratio when OpenAI supports it;
 * ratios outside 1:3..3:1 are clamped, then post-processed to the exact target.
 */
export function sourceSizeForTarget(targetWidth, targetHeight, quality = 'medium') {
  if (!(targetWidth > 0 && targetHeight > 0)) throw new Error('Target width/height must be positive.');

  const targetRatio = targetWidth / targetHeight;
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, targetRatio));

  // Source budget: enough detail for final ads without defaulting to expensive 4K.
  const longEdgeBase = ['xhigh', 'max'].includes(quality) ? 2048 : 1536;
  let width;
  let height;

  if (ratio >= 1) {
    width = Math.min(MAX_EDGE, longEdgeBase);
    height = width / ratio;
  } else {
    height = Math.min(MAX_EDGE, longEdgeBase);
    width = height * ratio;
  }

  width = round16(width);
  height = round16(height);

  let pixels = width * height;
  if (pixels < MIN_PIXELS) {
    const scale = Math.sqrt(MIN_PIXELS / pixels) * 1.02;
    width = round16(width * scale);
    height = round16(height * scale);
  }

  pixels = width * height;
  if (pixels > MAX_PIXELS || width > MAX_EDGE || height > MAX_EDGE) {
    const scale = Math.min(
      Math.sqrt(MAX_PIXELS / pixels),
      MAX_EDGE / width,
      MAX_EDGE / height
    ) * 0.995;
    width = floor16(width * scale);
    height = floor16(height * scale);
  }

  // Defensively repair edge cases introduced by rounding.
  while (!isValidApiSize(width, height)) {
    if (width * height < MIN_PIXELS) {
      if (ratio >= 1) width += 16;
      else height += 16;
    } else if (width * height > MAX_PIXELS || width > MAX_EDGE || height > MAX_EDGE) {
      if (width >= height) width -= 16;
      else height -= 16;
    } else {
      // Ratio rounding case.
      if (width / height > MAX_RATIO) width = floor16(height * MAX_RATIO);
      else if (width / height < MIN_RATIO) height = floor16(width / MIN_RATIO);
      else break;
    }
  }

  return {
    apiWidth: width,
    apiHeight: height,
    apiSize: `${width}x${height}`,
    targetWidth,
    targetHeight,
    needsPostProcess: width !== targetWidth || height !== targetHeight,
    targetRatio,
    apiRatio: width / height,
    ratioWasClamped: targetRatio < MIN_RATIO || targetRatio > MAX_RATIO
  };
}
