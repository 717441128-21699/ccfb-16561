import type { Point, Quad, RgbaImage, StraightenResult, WrinkleField } from '../types';
import { createImage, edgeEnergy, sampleBilinear } from './image';

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function quadWidth(q: Quad): number {
  return (distance(q.tl, q.tr) + distance(q.bl, q.br)) / 2;
}

export function quadHeight(q: Quad): number {
  return (distance(q.tl, q.bl) + distance(q.tr, q.br)) / 2;
}

export function cloneQuad(q: Quad): Quad {
  return { tl: { ...q.tl }, tr: { ...q.tr }, br: { ...q.br }, bl: { ...q.bl } };
}

export function defaultQuad(width: number, height: number, inset = 0.08): Quad {
  const mx = width * inset;
  const my = height * inset;
  return {
    tl: { x: mx, y: my },
    tr: { x: width - mx, y: my * 0.8 },
    br: { x: width - mx * 0.7, y: height - my },
    bl: { x: mx * 0.9, y: height - my * 0.85 },
  };
}

/** 由 4 组对应点求 3x3 单应矩阵，行主序，约定 h33 = 1。 */
export function findHomography(src: Point[], dst: Point[]): number[] {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: X, y: Y } = dst[i];
    // h0 x + h1 y + h2 - X x h6 - X y h7 = X
    a.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    // h3 x + h4 y + h5 - Y x h6 - Y y h7 = Y
    a.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }

  // 高斯-约当消元解 8 个未知数；第 9 列为 RHS。
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const pv = a[col][col] || 1e-12;
    for (let c = col; c <= 8; c++) a[col][c] /= pv;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= 8; c++) a[r][c] -= factor * a[col][c];
    }
  }
  const h = a.map((row) => row[8]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(h: number[], x: number, y: number): Point {
  const d = h[6] * x + h[7] * y + h[8];
  return {
    x: (h[0] * x + h[1] * y + h[2]) / d,
    y: (h[3] * x + h[4] * y + h[5]) / d,
  };
}

/** 把任意四边形布面反向投影到矩形，并做双线性采样。 */
export function warpQuadToRect(
  img: RgbaImage,
  quad: Quad,
  outWidth: number,
  outHeight: number,
): RgbaImage {
  const dstCorners: Point[] = [
    { x: 0, y: 0 },
    { x: outWidth - 1, y: 0 },
    { x: outWidth - 1, y: outHeight - 1 },
    { x: 0, y: outHeight - 1 },
  ];
  const srcCorners = [quad.tl, quad.tr, quad.br, quad.bl];
  // 输出矩形 -> 照片四边形。
  const h = findHomography(dstCorners, srcCorners);
  const out = createImage(outWidth, outHeight);
  const od = out.data;

  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const p = applyHomography(h, x, y);
      const rgba = sampleBilinear(img, p.x, p.y);
      const i = (y * outWidth + x) * 4;
      od[i] = rgba[0];
      od[i + 1] = rgba[1];
      od[i + 2] = rgba[2];
      od[i + 3] = rgba[3];
    }
  }
  return out;
}

function smooth1d(values: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(values.length);
  if (radius <= 0) return values.slice();
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      n++;
    }
    out[i] = sum / n;
  }
  return out;
}

function meanZeroAndSmooth(values: Float32Array, smoothRadius: number): Float32Array {
  const smoothed = smooth1d(values, smoothRadius);
  let mean = 0;
  for (const v of smoothed) mean += v;
  mean /= smoothed.length || 1;
  for (let i = 0; i < smoothed.length; i++) smoothed[i] -= mean;
  return smoothed;
}

/**
 * 用相邻条带的竖直/水平边缘投影做局部块匹配，恢复缓慢变化的褶皱位移。
 * shiftX[yBand] 表示把理想格点映射回有褶皱图时需要增加的 x。
 */
export function estimateWrinkleField(img: RgbaImage, bandSize = 18): WrinkleField {
  const { width: w, height: h } = img;
  const { gx, gy } = edgeEnergy(img);
  const bandsX = Math.max(3, Math.floor(h / bandSize));
  const bandsY = Math.max(3, Math.floor(w / bandSize));
  const actualBandH = h / bandsX;
  const actualBandW = w / bandsY;

  const colProfiles: Float32Array[] = [];
  for (let b = 0; b < bandsX; b++) {
    const p = new Float32Array(w);
    const y0 = Math.floor(b * actualBandH);
    const y1 = Math.max(y0 + 1, Math.floor((b + 1) * actualBandH));
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) p[x] += gx[row + x];
    }
    // 对数压缩，防止某条强纹样边缘完全支配匹配。
    for (let x = 0; x < w; x++) p[x] = Math.log1p(p[x]);
    colProfiles.push(p);
  }

  const maxDeltaX = Math.max(3, Math.round(bandSize * 0.9));
  const rawShiftX = new Float32Array(bandsX);
  for (let b = 1; b < bandsX; b++) {
    const prev = colProfiles[b - 1];
    const cur = colProfiles[b];
    const base = rawShiftX[b - 1];
    let bestQ = 0;
    let bestCost = Infinity;
    const prevOffset = Math.round(base);
    for (let q = -maxDeltaX; q <= maxDeltaX; q++) {
      let cost = 0;
      let count = 0;
      // 隔点取样已经足够，且能把条带匹配控制在性能预算内。
      for (let x = 24; x < w - 24; x += 2) {
        const xp = x + prevOffset;
        const xc = x + prevOffset + q;
        if (xp < 1 || xp >= w - 1 || xc < 1 || xc >= w - 1) continue;
        const d = prev[xp] - cur[xc];
        cost += d * d;
        count++;
      }
      cost /= Math.max(1, count);
      if (cost < bestCost) {
        bestCost = cost;
        bestQ = q;
      }
    }
    rawShiftX[b] = base + bestQ;
  }

  const rowProfiles: Float32Array[] = [];
  for (let b = 0; b < bandsY; b++) {
    const p = new Float32Array(h);
    const x0 = Math.floor(b * actualBandW);
    const x1 = Math.max(x0 + 1, Math.floor((b + 1) * actualBandW));
    for (let x = x0; x < x1; x++) {
      for (let y = 0; y < h; y++) p[y] += gy[y * w + x];
    }
    for (let y = 0; y < h; y++) p[y] = Math.log1p(p[y]);
    rowProfiles.push(p);
  }

  const maxDeltaY = Math.max(3, Math.round(bandSize * 0.9));
  const rawShiftY = new Float32Array(bandsY);
  for (let b = 1; b < bandsY; b++) {
    const prev = rowProfiles[b - 1];
    const cur = rowProfiles[b];
    const base = rawShiftY[b - 1];
    let bestQ = 0;
    let bestCost = Infinity;
    const prevOffset = Math.round(base);
    for (let q = -maxDeltaY; q <= maxDeltaY; q++) {
      let cost = 0;
      let count = 0;
      for (let y = 24; y < h - 24; y += 2) {
        const yp = y + prevOffset;
        const yc = y + prevOffset + q;
        if (yp < 1 || yp >= h - 1 || yc < 1 || yc >= h - 1) continue;
        const d = prev[yp] - cur[yc];
        cost += d * d;
        count++;
      }
      cost /= Math.max(1, count);
      if (cost < bestCost) {
        bestCost = cost;
        bestQ = q;
      }
    }
    rawShiftY[b] = base + bestQ;
  }

  const shiftX = meanZeroAndSmooth(rawShiftX, 2);
  const shiftY = meanZeroAndSmooth(rawShiftY, 2);
  return {
    shiftX,
    shiftY,
    bandSize: actualBandH,
    referenceY: h / 2,
    referenceX: w / 2,
  };
}

export function fieldShiftAt(_field: WrinkleField, shifts: Float32Array, position: number, dimension: number): number {
  const bands = shifts.length;
  const f = (position / dimension) * bands - 0.5;
  const i0 = Math.max(0, Math.min(bands - 1, Math.floor(f)));
  const i1 = Math.max(0, Math.min(bands - 1, i0 + 1));
  const t = Math.max(0, Math.min(1, f - i0));
  return shifts[i0] * (1 - t) + shifts[i1] * t;
}

/** 按估计出的缓慢位移场反向重采样，使经线和纬线重新变直。 */
export function applyDewarp(img: RgbaImage, field: WrinkleField, strength = 1): RgbaImage {
  const out = createImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    const dx = fieldShiftAt(field, field.shiftX, y, img.height) * strength;
    for (let x = 0; x < img.width; x++) {
      const dy = fieldShiftAt(field, field.shiftY, x, img.width) * strength;
      const rgba = sampleBilinear(img, x + dx, y + dy);
      const i = (y * img.width + x) * 4;
      out.data[i] = rgba[0];
      out.data[i + 1] = rgba[1];
      out.data[i + 2] = rgba[2];
      out.data[i + 3] = rgba[3];
    }
  }
  return out;
}

export function straightenImage(
  image: RgbaImage,
  quad: Quad,
  options: { outputMaxEdge?: number; dewarpStrength?: number; bandSize?: number } = {},
): StraightenResult {
  const outputMaxEdge = options.outputMaxEdge ?? 1800;
  const rawW = Math.max(64, Math.round(quadWidth(quad)));
  const rawH = Math.max(64, Math.round(quadHeight(quad)));
  const scale = Math.min(1, outputMaxEdge / Math.max(rawW, rawH));
  const outW = Math.max(64, Math.round(rawW * scale));
  const outH = Math.max(64, Math.round(rawH * scale));

  const warped = warpQuadToRect(image, quad, outW, outH);
  const wrinkle = estimateWrinkleField(warped, options.bandSize ?? 18);
  const strength = options.dewarpStrength ?? 0.85;
  const straightened = strength !== 0 ? applyDewarp(warped, wrinkle, strength) : warped;

  const dstCorners: Point[] = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];
  const homography = findHomography(dstCorners, [quad.tl, quad.tr, quad.br, quad.bl]);

  return { image: straightened, width: outW, height: outH, homography, wrinkle, quad };
}

/**
 * 在低分辨率预览上粗检布面四边形。测试样片使用深色背景，上传文物照则可手动拖角修正。
 * 算法：亮度/饱和度生成布面掩码，按行列投影找最大连续区域，再用边缘极值收敛四角。
 */
export function estimateClothQuad(img: RgbaImage): Quad {
  const w = img.width;
  const h = img.height;
  const mask = new Uint8Array(w * h);
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = img.data[i];
      const g = img.data[i + 1];
      const b = img.data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // 博物馆背景通常较暗或低饱和；布面有纹样且亮度/色彩变化更大。
      const cloth = lum > 42 && (max - min > 14 || lum > 92);
      if (cloth) {
        mask[y * w + x] = 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxX - minX < w * 0.2 || maxY - minY < h * 0.2) {
    return defaultQuad(w, h);
  }

  // 用四角局部掩码质心代替纯 bounding box，以容纳透视斜边。
  const corner = (cx: number, cy: number, rw: number, rh: number): Point => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    const x0 = Math.max(0, Math.floor(cx - rw));
    const x1 = Math.min(w, Math.floor(cx + rw));
    const y0 = Math.max(0, Math.floor(cy - rh));
    const y1 = Math.min(h, Math.floor(cy + rh));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (mask[y * w + x]) {
          sx += x;
          sy += y;
          n++;
        }
      }
    }
    return n > 20 ? { x: sx / n, y: sy / n } : { x: cx, y: cy };
  };

  const rw = (maxX - minX) * 0.22;
  const rh = (maxY - minY) * 0.22;
  const tl = corner(minX + rw, minY + rh, rw, rh);
  const tr = corner(maxX - rw, minY + rh, rw, rh);
  const br = corner(maxX - rw, maxY - rh, rw, rh);
  const bl = corner(minX + rw, maxY - rh, rw, rh);

  // 质心会向内缩，沿对角线外推一点。
  const expand = (p: Point, fx: number, fy: number): Point => ({
    x: p.x + (p.x - (minX + maxX) / 2) * fx,
    y: p.y + (p.y - (minY + maxY) / 2) * fy,
  });
  return {
    tl: expand(tl, 0.18, 0.18),
    tr: expand(tr, 0.18, 0.18),
    br: expand(br, 0.18, 0.18),
    bl: expand(bl, 0.18, 0.18),
  };
}
