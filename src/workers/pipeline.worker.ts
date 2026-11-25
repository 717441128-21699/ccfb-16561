/// <reference lib="webworker" />
import type { WorkerRequest, WorkerResponse } from '../types';
import { generateSample } from '../lib/synthetic';
import { estimateClothQuad, straightenImage } from '../lib/geometry';
import { detectRepeatFromGrid } from '../lib/grid';
import { buildPattern } from '../lib/repeat';
import { runPipeline } from '../lib/pipeline';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    let result: unknown;
    switch (req.type) {
      case 'generateSample':
        result = generateSample(req.spec);
        break;
      case 'estimateQuad':
        result = estimateClothQuad(req.image);
        break;
      case 'straighten':
        result = straightenImage(req.image, req.options.quad, req.options);
        break;
      case 'detectRepeat':
        result = detectRepeatFromGrid(req.image, req.grid);
        break;
      case 'buildPattern':
        result = buildPattern(req.image, req.repeat, req.colorCount);
        break;
      case 'pipeline':
        result = runPipeline(req.image, req.options);
        break;
    }
    const res: WorkerResponse = { id: req.id, ok: true, type: req.type, result };
    ctx.postMessage(res);
  } catch (error) {
    const res: WorkerResponse = {
      id: req.id,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error),
    };
    ctx.postMessage(res);
  }
};
