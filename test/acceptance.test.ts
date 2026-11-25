import { describe, expect, test } from 'vitest';
import type { PatternKind } from '../src/types';
import {
  ACCEPTANCE_DEGRADATION,
  createSampleSpec,
  generateSample,
  SEVERITY_PRESETS,
} from '../src/lib/synthetic';
import { runPipeline } from '../src/lib/pipeline';
import { alignPatternToGroundTruth } from '../src/lib/metrics';

const KINDS: PatternKind[] = ['round-flower', 'interlocking-lotus', 'cloud', 'meander', 'phoenix'];

describe('文物织锦意匠图验收指标', () => {
  test.each(KINDS)('%s：循环根数差≤1且格色一致率≥95%', (kind) => {
    const spec = createSampleSpec(kind, { ...ACCEPTANCE_DEGRADATION }, { longEdge: 1900 });
    const groundTruth = generateSample(spec);
    const result = runPipeline(groundTruth.image, {
      colorCount: spec.palette.length,
      initialQuad: groundTruth.photoQuad,
    });
    const report = alignPatternToGroundTruth(result.pattern, groundTruth);

    expect(report.warpCountError).toBeLessThanOrEqual(1);
    expect(report.weftCountError).toBeLessThanOrEqual(1);
    expect(report.accuracy).toBeGreaterThanOrEqual(0.95);
  }, 60_000);

  test.each(Object.keys(SEVERITY_PRESETS))('三档退化标记完整：%s', (level) => {
    const degradation = SEVERITY_PRESETS[level];
    expect(degradation.wrinkle).toBeGreaterThan(0);
    expect(degradation.oblique).toBeGreaterThan(0);
    expect(degradation.fade).toBeGreaterThan(0);
    expect(degradation.damage).toBeGreaterThan(0);
    expect(degradation.seed).toEqual(expect.any(Number));

    const spec = createSampleSpec('round-flower', level as keyof typeof SEVERITY_PRESETS);
    expect(spec.degradation).toMatchObject(degradation);
    const sample = generateSample(spec);
    expect(sample.image.width * sample.image.height).toBeGreaterThan(500_000);
    expect(sample.cells.length).toBe(spec.warpCount * spec.weftCount);
  });
});
