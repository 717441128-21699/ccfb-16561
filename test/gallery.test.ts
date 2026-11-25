import { expect, test } from 'vitest';
import type { PatternKind } from '../src/types';
import { createSampleSpec, generateSample, SEVERITY_PRESETS } from '../src/lib/synthetic';
import { runPipeline } from '../src/lib/pipeline';
import { alignPatternToGroundTruth } from '../src/lib/metrics';

const KINDS: PatternKind[] = ['round-flower', 'interlocking-lotus', 'cloud', 'meander', 'phoenix'];
const LEVELS = Object.keys(SEVERITY_PRESETS) as Array<keyof typeof SEVERITY_PRESETS>;

test.each(LEVELS.flatMap((level) => KINDS.map((kind) => [level, kind] as const)))(
  '样片 %s / %s 满足根数与归色阈值',
  (level, kind) => {
    const spec = createSampleSpec(kind, level, { longEdge: 1700 });
    const gt = generateSample(spec);
    const result = runPipeline(gt.image, {
      colorCount: spec.palette.length,
      initialQuad: gt.photoQuad,
    });
    const report = alignPatternToGroundTruth(result.pattern, gt);
    expect(report.warpCountError).toBeLessThanOrEqual(1);
    expect(report.weftCountError).toBeLessThanOrEqual(1);
    expect(report.accuracy).toBeGreaterThanOrEqual(0.95);
  },
  60_000,
);
