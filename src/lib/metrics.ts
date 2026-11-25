import type { GroundTruth, PatternResult } from '../types';
import { hexToRgb, colorDistance } from './color';

/** 方阵/矩形代价矩阵的最小权完美匹配（Hungarian algorithm）。 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length;
  const m = Math.max(n, cost[0]?.length ?? n);
  const a: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) a[i][j] = cost[i - 1][j - 1] ?? 1e9;
  }
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = a[i0][j] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const assignment = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j] >= 1 && p[j] <= n) assignment[p[j] - 1] = j - 1;
  }
  return assignment;
}

function mapPaletteByColor(pattern: PatternResult, gt: GroundTruth): number[] {
  const gtPalette = gt.spec.palette.map(hexToRgb);
  return pattern.palette.map((c) => {
    let best = 0;
    let bestD = Infinity;
    gtPalette.forEach((g, i) => {
      const d = colorDistance(c, g);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  });
}

export interface AlignmentReport {
  accuracy: number;
  matched: number;
  total: number;
  shiftX: number;
  shiftY: number;
  paletteMap: number[];
  warpCountError: number;
  weftCountError: number;
}

/**
 * 对齐输出意匠图与老工艺员格阵：允许循环起点平移，并求最优色号置换。
 * 若自动根数差一根，则按最近邻坐标映射到人工格阵后统计全部人工格。
 */
export function alignPatternToGroundTruth(pattern: PatternResult, gt: GroundTruth): AlignmentReport {
  const gw = gt.spec.warpCount;
  const gh = gt.spec.weftCount;
  const pw = pattern.width;
  const ph = pattern.height;
  const warpCountError = Math.abs(pw - gw);
  const weftCountError = Math.abs(ph - gh);
  const colorMap = mapPaletteByColor(pattern, gt);
  const mapped = Uint8Array.from(pattern.indices, (v) => colorMap[v] ?? v);

  let best = { accuracy: -1, matched: 0, total: gw * gh, shiftX: 0, shiftY: 0, paletteMap: colorMap };

  if (pw === gw && ph === gh) {
    for (let sy = 0; sy < gh; sy++) {
      for (let sx = 0; sx < gw; sx++) {
        let matched = 0;
        const total = gw * gh;
        for (let y = 0; y < gh; y++) {
          for (let x = 0; x < gw; x++) {
            const ox = (x + sx) % gw;
            const oy = (y + sy) % gh;
            if (mapped[oy * pw + ox] === gt.cells[y * gw + x]) matched++;
          }
        }
        if (matched > best.matched) {
          best = { accuracy: matched / total, matched, total, shiftX: sx, shiftY: sy, paletteMap: colorMap };
        }
      }
    }
  } else {
    // 根数差一时，在小范围相位中找最佳最近邻映射。
    for (let sy = -2; sy <= 2; sy++) {
      for (let sx = -2; sx <= 2; sx++) {
        let matched = 0;
        for (let y = 0; y < gh; y++) {
          const py = Math.max(0, Math.min(ph - 1, Math.round((y * ph) / gh + sy)));
          for (let x = 0; x < gw; x++) {
            const px = Math.max(0, Math.min(pw - 1, Math.round((x * pw) / gw + sx)));
            if (mapped[py * pw + px] === gt.cells[y * gw + x]) matched++;
          }
        }
        const total = gw * gh;
        if (matched > best.matched) {
          best = { accuracy: matched / total, matched, total, shiftX: sx, shiftY: sy, paletteMap: colorMap };
        }
      }
    }
  }

  // 在最佳几何对齐上用混淆矩阵求一次最优色号置换，修正褪色造成的色板近邻碰撞。
  const kOut = pattern.palette.length;
  const kGt = gt.spec.palette.length;
  const n = Math.max(kOut, kGt);
  const confusion = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let outValue: number;
      if (pw === gw && ph === gh) {
        const ox = (x + best.shiftX) % gw;
        const oy = (y + best.shiftY) % gh;
        outValue = pattern.indices[oy * pw + ox];
      } else {
        const py = Math.max(0, Math.min(ph - 1, Math.round((y * ph) / gh + best.shiftY)));
        const px = Math.max(0, Math.min(pw - 1, Math.round((x * pw) / gw + best.shiftX)));
        outValue = pattern.indices[py * pw + px];
      }
      confusion[outValue][gt.cells[y * gw + x]]++;
    }
  }
  const cost = confusion.map((row) => row.map((count) => -count));
  const assignment = hungarian(cost);
  const optimalMap = pattern.palette.map((_, i) => assignment[i] ?? colorMap[i] ?? 0);

  let matched = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let outIndex: number;
      if (pw === gw && ph === gh) {
        outIndex = ((y + best.shiftY) % gh) * pw + ((x + best.shiftX) % gw);
      } else {
        const py = Math.max(0, Math.min(ph - 1, Math.round((y * ph) / gh + best.shiftY)));
        const px = Math.max(0, Math.min(pw - 1, Math.round((x * pw) / gw + best.shiftX)));
        outIndex = py * pw + px;
      }
      if (optimalMap[pattern.indices[outIndex]] === gt.cells[y * gw + x]) matched++;
    }
  }

  return {
    accuracy: matched / (gw * gh),
    matched,
    total: gw * gh,
    shiftX: best.shiftX,
    shiftY: best.shiftY,
    paletteMap: optimalMap,
    warpCountError,
    weftCountError,
  };
}
