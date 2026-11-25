import type { GridGeometry, RepeatInfo, RgbaImage } from '../types';
import { colorDistance, rgbToOklab } from './color';
import { edgeEnergy } from './image';

function parabolicPeak(values: number[], index: number): number {
  const i0 = Math.max(0, index - 1);
  const i1 = index;
  const i2 = Math.min(values.length - 1, index + 1);
  const y0 = values[i0];
  const y1 = values[i1];
  const y2 = values[i2];
  const denom = y0 - 2 * y1 + y2;
  if (Math.abs(denom) < 1e-12) return index;
  return index + (0.5 * (y0 - y2)) / denom;
}

/**
 * 从边缘投影的自相关峰估计经纬丝平均像素间距。
 * 织物纹理本身提供高频周期，纹样边界只贡献局部、非周期峰。
 */
export function estimatePitch(profile: Float32Array, minPitch = 3, maxPitch = 42): { pitch: number; strength: number } {
  const n = profile.length;
  let mean = 0;
  for (const v of profile) mean += v;
  mean /= n || 1;
  let variance = 0;
  const centered = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    centered[i] = profile[i] - mean;
    variance += centered[i] * centered[i];
  }
  variance /= n || 1;
  if (variance < 1e-8) return { pitch: 8, strength: 0 };

  const maxLag = Math.min(maxPitch, Math.floor(n / 3));
  const acf: number[] = new Array(maxLag + 1).fill(0);
  for (let lag = minPitch; lag <= maxLag; lag++) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i + lag < n; i++) {
      sum += centered[i] * centered[i + lag];
      count++;
    }
    acf[lag] = sum / (count * variance);
  }

  // 找第一个显著局部峰；若自相关峰不明确，则用差分最小的周期。
  let bestLag = minPitch;
  let bestAcf = -Infinity;
  const peaks: number[] = [];
  for (let lag = minPitch + 1; lag < maxLag; lag++) {
    if (acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1] && acf[lag] > 0.08) {
      peaks.push(lag);
      if (acf[lag] > bestAcf) {
        bestAcf = acf[lag];
        bestLag = lag;
      }
    }
  }

  if (peaks.length > 0) {
    // 排除倍频：若更小的峰具有相近强度，取基频。
    const strongest = Math.max(...peaks.map((p) => acf[p]));
    const fundamental = peaks.find((p) => acf[p] >= strongest * 0.72) ?? bestLag;
    return { pitch: parabolicPeak(acf, fundamental), strength: acf[fundamental] };
  }

  let bestCost = Infinity;
  for (let p = minPitch; p <= maxLag; p++) {
    let cost = 0;
    let count = 0;
    for (let i = 0; i + p < n; i++) {
      const d = centered[i] - centered[i + p];
      cost += d * d;
      count++;
    }
    cost /= count || 1;
    if (cost < bestCost) {
      bestCost = cost;
      bestLag = p;
    }
  }
  return { pitch: bestLag, strength: Math.max(0, acf[bestLag] ?? 0) };
}

/**
 * 直接搜索整幅布面的格数。单靠自相关容易取到倍频/半频，而“边界能量高、
 * 格心能量低”的梳状对比度能区分真实格距和它的倍数。
 */
export function searchGridCount(
  profile: Float32Array,
  size: number,
  range?: { minCount: number; maxCount: number },
): { count: number; score: number } {
  const minPitch = 3.2;
  const maxPitch = 26;
  const minCount = range?.minCount ?? Math.max(8, Math.floor((size - 1) / maxPitch));
  const maxCount =
    range?.maxCount ?? Math.min(Math.floor((size - 1) / minPitch), Math.floor(size / 2));

  const at = (x: number): number => {
    const i = Math.max(0, Math.min(profile.length - 1, Math.round(x)));
    return profile[i];
  };
  const localMax = (x: number, pitch: number): number => {
    const r = pitch < 5 ? 0 : 1;
    let v = -Infinity;
    for (let d = -r; d <= r; d++) v = Math.max(v, at(x + d));
    return v;
  };
  const centerEnergy = (x: number, pitch: number): number => {
    const r = pitch < 7 ? 0 : 1;
    let sum = 0;
    let n = 0;
    for (let d = -r; d <= r; d++) {
      sum += at(x + d);
      n++;
    }
    return sum / n;
  };

  let bestCount = Math.round(size / 7);
  let bestScore = -Infinity;

  for (let count = minCount; count <= maxCount; count++) {
    const pitch = (size - 1) / count;
    let boundary = 0;
    let center = 0;
    let bn = 0;
    let cn = 0;
    for (let k = 1; k < count; k++) {
      boundary += localMax(k * pitch, pitch);
      bn++;
    }
    for (let k = 0; k < count; k++) {
      center += centerEnergy((k + 0.5) * pitch, pitch);
      cn++;
    }
    const score = boundary / Math.max(1, bn) - center / Math.max(1, cn);
    if (score > bestScore) {
      bestScore = score;
      bestCount = count;
    }
  }

  return { count: bestCount, score: bestScore };
}

export function estimateGridGeometry(img: RgbaImage): GridGeometry {
  const { width: w, height: h } = img;
  const { gx, gy } = edgeEnergy(img);

  // 用中央 92% 区域，避开拉平边缘可能的空像素/背景。
  const x0 = Math.floor(w * 0.04);
  const x1 = Math.ceil(w * 0.96);
  const y0 = Math.floor(h * 0.04);
  const y1 = Math.ceil(h * 0.96);

  const colProfile = new Float32Array(w);
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) colProfile[x] += gx[row + x];
  }
  const rowProfile = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) rowProfile[y] += gy[row + x];
  }

  const pitchEstimateX = estimatePitch(colProfile, 4, Math.min(24, Math.floor(w / 6))).pitch;
  const pitchEstimateY = estimatePitch(rowProfile, 4, Math.min(24, Math.floor(h / 6))).pitch;
  const approxCols = Math.round((w - 1) / pitchEstimateX);
  const approxRows = Math.round((h - 1) / pitchEstimateY);
  const cols = searchGridCount(colProfile, w, {
    minCount: Math.max(8, approxCols - Math.max(6, Math.round(approxCols * 0.08))),
    maxCount: Math.min(w / 3, approxCols + Math.max(6, Math.round(approxCols * 0.08))),
  }).count;
  const rows = searchGridCount(rowProfile, h, {
    minCount: Math.max(8, approxRows - Math.max(6, Math.round(approxRows * 0.08))),
    maxCount: Math.min(h / 3, approxRows + Math.max(6, Math.round(approxRows * 0.08))),
  }).count;
  const pitchX = (w - 1) / cols;
  const pitchY = (h - 1) / rows;

  return {
    totalCols: cols,
    totalRows: rows,
    originX: pitchX / 2,
    originY: pitchY / 2,
    pitchX,
    pitchY,
  };
}

export function cellCenter(grid: GridGeometry, col: number, row: number): { x: number; y: number } {
  return {
    x: grid.originX + col * grid.pitchX,
    y: grid.originY + row * grid.pitchY,
  };
}

/** 每格取中心及中心附近四点，降低恰好落在织纹高光/污点上的概率。 */
export function sampleCellRgb(img: RgbaImage, grid: GridGeometry, col: number, row: number): [number, number, number] {
  const c = cellCenter(grid, col, row);
  const rx = Math.max(0.6, grid.pitchX * 0.18);
  const ry = Math.max(0.6, grid.pitchY * 0.18);
  const points: Array<[number, number]> = [
    [c.x, c.y],
    [c.x - rx, c.y - ry],
    [c.x + rx, c.y - ry],
    [c.x - rx, c.y + ry],
    [c.x + rx, c.y + ry],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [x, y] of points) {
    const ix = Math.max(0, Math.min(img.width - 1, Math.round(x)));
    const iy = Math.max(0, Math.min(img.height - 1, Math.round(y)));
    const i = (iy * img.width + ix) * 4;
    r += img.data[i];
    g += img.data[i + 1];
    b += img.data[i + 2];
  }
  return [r / points.length, g / points.length, b / points.length];
}

export function sampleGridColors(img: RgbaImage, grid: GridGeometry): Float32Array {
  const out = new Float32Array(grid.totalCols * grid.totalRows * 3);
  for (let row = 0; row < grid.totalRows; row++) {
    for (let col = 0; col < grid.totalCols; col++) {
      const [r, g, b] = sampleCellRgb(img, grid, col, row);
      const i = (row * grid.totalCols + col) * 3;
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
  }
  return out;
}

/** 去除各循环之间缓慢的曝光/黄化差异，只保留用于找周期的色度与相对亮度。 */
function repeatFeature(colors: Float32Array, cell: number): [number, number, number] {
  const i = cell * 3;
  const [L, a, b] = rgbToOklab(colors[i], colors[i + 1], colors[i + 2]);
  // 黄化主要推高 b、褪色主要推高 L；周期匹配时降低这两个低频方向的权重。
  return [L * 0.45, a * 1.45, b * 0.55];
}

function featureDistance(a: [number, number, number], b: [number, number, number]): number {
  const d0 = a[0] - b[0];
  const d1 = a[1] - b[1];
  const d2 = a[2] - b[2];
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}

export interface PeriodResult {
  period: number;
  score: number;
  confidence: number;
}

export function findPeriod1D(
  colors: Float32Array,
  totalCols: number,
  totalRows: number,
  axis: 'x' | 'y',
  minPeriod = 12,
): PeriodResult {
  const length = axis === 'x' ? totalCols : totalRows;
  const other = axis === 'x' ? totalRows : totalCols;
  const maxPeriod = Math.max(minPeriod + 1, Math.floor(length / 2.2));
  const features = new Array<[number, number, number]>(totalCols * totalRows);
  for (let c = 0; c < totalCols * totalRows; c++) features[c] = repeatFeature(colors, c);

  const scores = new Float32Array(maxPeriod + 1);
  for (let p = minPeriod; p <= maxPeriod; p++) {
    const distances: number[] = [];
    const stepRows = Math.max(1, Math.floor(other / 48));
    for (let oi = 0; oi < other; oi += stepRows) {
      for (let a = 0; a + p < length; a++) {
        let idxA: number;
        let idxB: number;
        if (axis === 'x') {
          idxA = oi * totalCols + a;
          idxB = oi * totalCols + a + p;
        } else {
          idxA = a * totalCols + oi;
          idxB = (a + p) * totalCols + oi;
        }
        distances.push(featureDistance(features[idxA], features[idxB]));
      }
    }
    distances.sort((a, b) => a - b);
    const q = (f: number) => distances[Math.min(distances.length - 1, Math.floor(distances.length * f))] ?? 1;
    // 高分位必须匹配：中位数会放任少数纹样主体不重合，从而误选近似半周期。
    scores[p] = q(0.25) * 0.2 + q(0.75) * 0.3 + q(0.9) * 0.5;
  }

  let minScore = Infinity;
  for (let p = minPeriod; p <= maxPeriod; p++) minScore = Math.min(minScore, scores[p]);
  const candidates: number[] = [];
  for (let p = minPeriod; p <= maxPeriod; p++) {
    if (scores[p] <= minScore * 1.045 + 0.004) candidates.push(p);
  }
  const period = candidates[0] ?? minPeriod;
  const baseline =
    scores.slice(minPeriod, maxPeriod + 1).reduce((a, b) => a + b, 0) /
    Math.max(1, maxPeriod - minPeriod + 1);
  const confidence = Math.max(0, Math.min(1, 1 - scores[period] / Math.max(0.08, baseline)));
  return { period, score: scores[period], confidence };
}

/**
 * 在格阵颜色上寻找纹样基频循环。候选周期取所有接近全局最佳的最小值中的最小者，
 * 以避免把两个或三个循环误当成一个完整单元。
 */
export function detectRepeatFromGrid(img: RgbaImage, providedGrid?: GridGeometry): RepeatInfo {
  const grid = providedGrid ?? estimateGridGeometry(img);
  const colors = sampleGridColors(img, grid);

  const minX = Math.max(10, Math.round(grid.totalCols / 18));
  const minY = Math.max(10, Math.round(grid.totalRows / 18));
  const px = findPeriod1D(colors, grid.totalCols, grid.totalRows, 'x', minX);
  const py = findPeriod1D(colors, grid.totalCols, grid.totalRows, 'y', minY);

  // 在 ±2 格内做二维叠合残差精修，纠正投影周期的整数取整。
  const refinedX = refinePeriod2D(colors, grid.totalCols, grid.totalRows, px.period, 'x');
  const refinedY = refinePeriod2D(colors, grid.totalCols, grid.totalRows, py.period, 'y');

  const repeatsX = Math.max(1, Math.floor(grid.totalCols / refinedX));
  const repeatsY = Math.max(1, Math.floor(grid.totalRows / refinedY));
  const confidence = Math.min(1, (px.confidence + py.confidence) * 0.75 + 0.2);

  return {
    warpCount: refinedX,
    weftCount: refinedY,
    repeatsX,
    repeatsY,
    offsetCol: 0,
    offsetRow: 0,
    grid,
    confidence,
  };
}

function refinePeriod2D(
  colors: Float32Array,
  cols: number,
  rows: number,
  initial: number,
  axis: 'x' | 'y',
): number {
  let bestP = initial;
  let bestCost = Infinity;
  for (let p = Math.max(4, initial - 2); p <= Math.min(axis === 'x' ? cols / 2 : rows / 2, initial + 2); p++) {
    let cost = 0;
    let n = 0;
    if (axis === 'x') {
      for (let y = 0; y < rows; y += 2) {
        for (let x = 0; x + p < cols; x++) {
          const a = (y * cols + x) * 3;
          const b = (y * cols + x + p) * 3;
          cost += colorDistance(
            { r: colors[a], g: colors[a + 1], b: colors[a + 2] },
            { r: colors[b], g: colors[b + 1], b: colors[b + 2] },
          );
          n++;
        }
      }
    } else {
      for (let y = 0; y + p < rows; y++) {
        for (let x = 0; x < cols; x += 2) {
          const a = (y * cols + x) * 3;
          const b = ((y + p) * cols + x) * 3;
          cost += colorDistance(
            { r: colors[a], g: colors[a + 1], b: colors[a + 2] },
            { r: colors[b], g: colors[b + 1], b: colors[b + 2] },
          );
          n++;
        }
      }
    }
    cost /= Math.max(1, n);
    if (cost < bestCost) {
      bestCost = cost;
      bestP = p;
    }
  }
  return bestP;
}
