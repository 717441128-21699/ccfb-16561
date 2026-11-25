import type { PatternResult, RepeatInfo, RgbaImage } from '../types';
import { medianRgb } from './color';
import { cellCenter } from './grid';
import { clusterColors } from './palette';

type Rgb = [number, number, number];

/** 对一个格点的中心小邻域取五点中位数，避免单点正好落在织纹或尘粒上。 */
export function sampleCellMedianRgb(
  img: RgbaImage,
  repeat: RepeatInfo,
  col: number,
  row: number,
): Rgb {
  const grid = repeat.grid;
  const c = cellCenter(grid, col, row);
  const rx = Math.max(0.55, grid.pitchX * 0.16);
  const ry = Math.max(0.55, grid.pitchY * 0.16);
  const coords: Array<[number, number]> = [
    [c.x, c.y],
    [c.x - rx, c.y],
    [c.x + rx, c.y],
    [c.x, c.y - ry],
    [c.x, c.y + ry],
  ];
  const samples: number[][] = [];
  for (const [fx, fy] of coords) {
    const x = Math.max(0, Math.min(img.width - 1, Math.round(fx)));
    const y = Math.max(0, Math.min(img.height - 1, Math.round(fy)));
    const i = (y * img.width + x) * 4;
    samples.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
  }
  const med = medianRgb(samples);
  return [med.r, med.g, med.b];
}

function samplePatchRgb(img: RgbaImage, x: number, y: number): Rgb {
  const samples: number[][] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ix = Math.max(0, Math.min(img.width - 1, Math.round(x + dx)));
      const iy = Math.max(0, Math.min(img.height - 1, Math.round(y + dy)));
      const i = (iy * img.width + ix) * 4;
      samples.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
    }
  }
  const m = medianRgb(samples);
  return [m.r, m.g, m.b];
}

function rgbDistance(a: Rgb, b: Rgb): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr * 0.85 + dg * dg * 1.1 + db * db * 1.05);
}

interface RepeatSite {
  x: number;
  y: number;
  initial: Rgb;
}

/**
 * 在预测格点附近做小范围对齐。褶皱会让同一意匠格在不同循环里偏移零点几格，
 * 以稳健中位色为模板搜索最近邻丝束中心，可在叠合前消除这种局部位移。
 */
function alignSiteColor(img: RgbaImage, site: RepeatSite, reference: Rgb, radius: number): Rgb {
  let bestColor = site.initial;
  let bestCost = rgbDistance(site.initial, reference);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const color = samplePatchRgb(img, site.x + dx, site.y + dy);
      const displacementPenalty = (Math.abs(dx) + Math.abs(dy)) * 22;
      const cost = rgbDistance(color, reference) + displacementPenalty;
      if (cost < bestCost) {
        bestCost = cost;
        bestColor = color;
      }
    }
  }
  return bestColor;
}

/**
 * 将若干循环中同一意匠格对应的颜色做逐通道中位数。
 * 污渍、破洞只出现在部分循环时会作为离群值被丢弃。
 */
export function foldRepeats(
  image: RgbaImage,
  repeat: RepeatInfo,
): { colors: Array<[number, number, number]>; mergedCounts: Uint16Array; spreads: Float32Array } {
  const { warpCount: w, weftCount: h, offsetCol, offsetRow, grid } = repeat;
  const colors: Array<[number, number, number]> = new Array(w * h);
  const mergedCounts = new Uint16Array(w * h);
  const spreads = new Float32Array(w * h);

  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const tileIndex = row * w + col;
      const sites: RepeatSite[] = [];

      for (let ry = 0; ry < repeat.repeatsY + 1; ry++) {
        const globalRow = offsetRow + row + ry * h;
        if (globalRow < 0 || globalRow >= grid.totalRows) continue;
        for (let rx = 0; rx < repeat.repeatsX + 1; rx++) {
          const globalCol = offsetCol + col + rx * w;
          if (globalCol < 0 || globalCol >= grid.totalCols) continue;
          const center = cellCenter(grid, globalCol, globalRow);
          sites.push({
            x: center.x,
            y: center.y,
            initial: sampleCellMedianRgb(image, repeat, globalCol, globalRow),
          });
        }
      }

      let aligned = sites.map((s) => s.initial);
      let med = medianRgb(aligned);
      const searchRadius = 0;
      // 一次稳健模板校正即可；第二次容易沿相似色块漂移到相邻组织点。
      const reference: Rgb = [med.r, med.g, med.b];
      aligned = sites.map((site) => alignSiteColor(image, site, reference, searchRadius));
      med = medianRgb(aligned);

      mergedCounts[tileIndex] = aligned.length;
      colors[tileIndex] = [med.r, med.g, med.b];

      let spreadSum = 0;
      for (const s of aligned) {
        const dr = s[0] - med.r;
        const dg = s[1] - med.g;
        const db = s[2] - med.b;
        spreadSum += Math.sqrt(dr * dr + dg * dg + db * db);
      }
      spreads[tileIndex] = aligned.length ? spreadSum / aligned.length : 0;
    }
  }

  return { colors, mergedCounts, spreads };
}

export function buildPattern(
  image: RgbaImage,
  repeat: RepeatInfo,
  colorCount: number,
): PatternResult {
  const w = repeat.warpCount;
  const h = repeat.weftCount;
  const folded = foldRepeats(image, repeat);
  const clustered = clusterColors(folded.colors, colorCount, 17);

  const usage = new Array<number>(clustered.palette.length).fill(0);
  const confidence = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    usage[clustered.assignments[i]]++;
    // 簇距离和叠合离散度共同决定可信度；UI 可高亮低可信格供工艺员复核。
    const clusterConf = Math.max(0, 1 - clustered.distances[i] / 0.16);
    const foldConf = Math.max(0, 1 - folded.spreads[i] / 95);
    const countBonus = Math.min(1, folded.mergedCounts[i] / 4);
    confidence[i] = Math.max(0, Math.min(1, clusterConf * 0.55 + foldConf * 0.3 + countBonus * 0.15));
  }

  return {
    width: w,
    height: h,
    indices: clustered.assignments.slice(),
    palette: clustered.palette,
    usage,
    confidence,
    mergedRepeats: Math.max(repeat.repeatsX, repeat.repeatsY),
  };
}

/** 全局替换某一色号；返回新的索引数组，供编辑页撤销栈使用。 */
export function replaceColor(indices: Uint8Array, from: number, to: number): Uint8Array {
  const next = indices.slice();
  for (let i = 0; i < next.length; i++) if (next[i] === from) next[i] = to;
  return next;
}

export function recalcUsage(indices: Uint8Array, colorCount: number): number[] {
  const usage = new Array<number>(colorCount).fill(0);
  for (const i of indices) usage[i]++;
  return usage;
}
