import { sourceSizeForTarget, isValidApiSize } from '../src/image-sizes.js';

const formats = [
  [1080,1080], [1080,1350], [1080,1920], [1200,628], [1200,675],
  [300,250], [336,280], [728,90], [970,250], [300,600], [320,100]
];
let failures = 0;
for (const [w,h] of formats) {
  const p = sourceSizeForTarget(w,h,'medium');
  const ok = isValidApiSize(p.apiWidth,p.apiHeight);
  console.log(`${w}x${h} -> ${p.apiSize} ${p.ratioWasClamped ? '(ratio clamped)' : ''} ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) failures++;
}
if (failures) process.exit(1);
