import { expect, test } from 'vitest';
import { createSampleSpec, generateSample, upscaleForPerformance } from '../src/lib/synthetic';
import { runPipeline } from '../src/lib/pipeline';

test('6000 万像素照片在 10 秒内出意匠图', () => {
  const spec = createSampleSpec('round-flower', '中度', { longEdge: 900 });
  const small = generateSample(spec);
  const large = upscaleForPerformance(small, 60);
  const megapixels = (large.image.width * large.image.height) / 1_000_000;
  expect(megapixels).toBeGreaterThanOrEqual(59.5);

  const start = performance.now();
  const result = runPipeline(large.image, {
    colorCount: spec.palette.length,
    initialQuad: large.quad,
    straighten: { outputMaxEdge: 1700, dewarpStrength: 0 },
  });
  const elapsed = performance.now() - start;

  console.log(
    `PERF ${large.image.width}x${large.image.height} (${megapixels.toFixed(1)}MP) total=${elapsed.toFixed(0)}ms straight=${result.timings.straighten.toFixed(0)}ms repeat=${result.timings.repeat.toFixed(0)}ms color=${result.timings.color.toFixed(0)}ms`,
  );
  expect(result.pattern.width).toBeGreaterThan(0);
  expect(elapsed).toBeLessThan(10_000);
}, 120_000);
