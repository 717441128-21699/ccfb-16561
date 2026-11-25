import type { PipelineOptions, PipelineResult, RgbaImage, RepeatInfo, StraightenResult } from '../types';
import { estimateClothQuad, straightenImage } from './geometry';
import { detectRepeatFromGrid } from './grid';
import { buildPattern } from './repeat';

export function runPipeline(image: RgbaImage, options: PipelineOptions): PipelineResult {
  const timings: Record<string, number> = {};
  let t0 = performance.now();

  const quad = options.initialQuad ?? estimateClothQuad(image);
  const straight: StraightenResult = straightenImage(image, quad, {
    outputMaxEdge: options.straighten?.outputMaxEdge ?? 1700,
    // 全局条带校正作为可选手动增强；默认更依赖循环叠合时的局部格点对齐，
    // 对缓慢褶皱更稳，也不会因条带误匹配而累积漂移。
    dewarpStrength: options.straighten?.dewarpStrength ?? 0,
    bandSize: options.straighten?.bandSize ?? 18,
  });
  timings.straighten = performance.now() - t0;

  t0 = performance.now();
  const repeat: RepeatInfo = detectRepeatFromGrid(straight.image);
  timings.repeat = performance.now() - t0;

  t0 = performance.now();
  const pattern = buildPattern(straight.image, repeat, options.colorCount);
  timings.color = performance.now() - t0;
  timings.total = Object.values(timings).reduce((a, b) => a + b, 0);

  return { straight, repeat, pattern, timings };
}
