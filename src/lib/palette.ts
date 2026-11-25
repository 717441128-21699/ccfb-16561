import type { PaletteColor } from '../types';
import { namePaletteColor, rgbToOklab } from './color';

interface LabSample {
  rgb: [number, number, number];
  lab: [number, number, number];
}

function deterministicRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** 确定性 k-means++，并尝试多个初值，避免褪色渐变把一个大色族劈成两簇。 */
export function clusterColors(
  colors: ArrayLike<number>[],
  k: number,
  seed = 1,
  iterations = 18,
): { palette: PaletteColor[]; assignments: Uint8Array; distances: Float32Array } {
  let best: ReturnType<typeof clusterColorsOnce> | null = null;
  let bestInertia = Infinity;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = clusterColorsOnce(colors, k, seed + attempt * 977, iterations);
    let inertia = 0;
    for (const d of result.distances) inertia += d * d;
    // 轻微奖励更均衡的簇，防止 41 格的墨色被大渐变吞掉。
    const counts = new Array(k).fill(0);
    for (const a of result.assignments) counts[a]++;
    const emptyPenalty = counts.filter((c: number) => c === 0).length * 1e6;
    inertia += emptyPenalty;
    if (inertia < bestInertia) {
      bestInertia = inertia;
      best = result;
    }
  }
  return best!;
}

function clusterColorsOnce(
  colors: ArrayLike<number>[],
  k: number,
  seed = 1,
  iterations = 18,
): { palette: PaletteColor[]; assignments: Uint8Array; distances: Float32Array } {
  const samples: LabSample[] = colors.map((c) => {
    const rgb: [number, number, number] = [c[0], c[1], c[2]];
    return { rgb, lab: rgbToOklab(rgb[0], rgb[1], rgb[2]) };
  });
  const n = samples.length;
  k = Math.max(1, Math.min(k, n));
  const rand = deterministicRandom(seed + n * 31 + k * 101);

  const centers: LabSample['lab'][] = [];
  const first = Math.floor(rand() * n);
  centers.push([...samples[first].lab]);

  while (centers.length < k) {
    const d2 = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const c of centers) {
        const dl = samples[i].lab[0] - c[0];
        const da = samples[i].lab[1] - c[1];
        const db = samples[i].lab[2] - c[2];
        const d = dl * dl * 0.12 + da * da * 2.8 + db * db * 2.0;
        if (d < best) best = d;
      }
      d2[i] = best;
      total += best;
    }
    let target = rand() * total;
    let idx = n - 1;
    for (let i = 0; i < n; i++) {
      target -= d2[i];
      if (target <= 0) {
        idx = i;
        break;
      }
    }
    centers.push([...samples[idx].lab]);
  }

  const assignments = new Uint8Array(n);
  const distances = new Float32Array(n);

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0, 0, 0] as number[]);
    // 前 3 个是 Lab 和，后 3 个是 RGB 和；最后一个位置改作计数会越界，故 count 单独存。
    const counts = new Float64Array(k);

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestD = Infinity;
      for (let ci = 0; ci < k; ci++) {
        const dl = samples[i].lab[0] - centers[ci][0];
        const da = samples[i].lab[1] - centers[ci][1];
        const db = samples[i].lab[2] - centers[ci][2];
        const d = dl * dl * 0.12 + da * da * 2.8 + db * db * 2.0;
        if (d < bestD) {
          bestD = d;
          best = ci;
        }
      }
      if (assignments[i] !== best) changed = true;
      assignments[i] = best;
      distances[i] = Math.sqrt(bestD);
      const s = sums[best];
      s[0] += samples[i].lab[0];
      s[1] += samples[i].lab[1];
      s[2] += samples[i].lab[2];
      s[3] += samples[i].rgb[0];
      s[4] += samples[i].rgb[1];
      s[5] += samples[i].rgb[2];
      counts[best]++;
    }

    for (let ci = 0; ci < k; ci++) {
      if (counts[ci] > 0) {
        const s = sums[ci];
        centers[ci] = [s[0] / counts[ci], s[1] / counts[ci], s[2] / counts[ci]];
      } else {
        // 空簇移到当前离中心最远的样本。
        let far = 0;
        let farD = -1;
        for (let i = 0; i < n; i++) {
          if (distances[i] > farD) {
            farD = distances[i];
            far = i;
          }
        }
        centers[ci] = [...samples[far].lab];
      }
    }
    if (!changed && iter > 2) break;
  }

  // 最后再分配一次并取 RGB 平均作为展示色。
  const rgbSums = Array.from({ length: k }, () => [0, 0, 0]);
  const counts = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let ci = 0; ci < k; ci++) {
      const dl = samples[i].lab[0] - centers[ci][0];
      const da = samples[i].lab[1] - centers[ci][1];
      const db = samples[i].lab[2] - centers[ci][2];
      const d = dl * dl + da * da * 1.4 + db * db * 1.4;
      if (d < bestD) {
        bestD = d;
        best = ci;
      }
    }
    assignments[i] = best;
    distances[i] = Math.sqrt(bestD);
    rgbSums[best][0] += samples[i].rgb[0];
    rgbSums[best][1] += samples[i].rgb[1];
    rgbSums[best][2] += samples[i].rgb[2];
    counts[best]++;
  }

  const palette: PaletteColor[] = rgbSums.map((s, i) => {
    const count = Math.max(1, counts[i]);
    const rgb = { r: s[0] / count, g: s[1] / count, b: s[2] / count };
    return { ...rgb, name: namePaletteColor(rgb, i) };
  });

  // 按色相/明度稳定排序，使每次色板顺序一致。
  const order = palette
    .map((p, i) => ({ i, key: rgbToOklab(p.r, p.g, p.b) }))
    .sort((a, b) => a.key[2] - b.key[2] || a.key[1] - b.key[1] || b.key[0] - a.key[0]);
  const remap = new Uint8Array(k);
  const sortedPalette: PaletteColor[] = [];
  order.forEach((o, newIndex) => {
    remap[o.i] = newIndex;
    sortedPalette.push(palette[o.i]);
  });
  for (let i = 0; i < assignments.length; i++) assignments[i] = remap[assignments[i]];

  return { palette: sortedPalette, assignments, distances };
}
