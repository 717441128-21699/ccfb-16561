import type { RgbaImage } from '../types';

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function getRgb(img: RgbaImage, x: number, y: number): [number, number, number] {
  const ix = x < 0 ? 0 : x >= img.width ? img.width - 1 : x | 0;
  const iy = y < 0 ? 0 : y >= img.height ? img.height - 1 : y | 0;
  const i = (iy * img.width + ix) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
}

export function setRgba(img: RgbaImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

/** 双线性采样；坐标越界时返回到边缘像素，适合几何拉平。 */
export function sampleBilinear(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const w = img.width;
  const h = img.height;
  if (x <= 0 && y <= 0) {
    const i = 0;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = x - x0;
  const fy = y - y0;

  const x0c = Math.max(0, Math.min(w - 1, x0));
  const x1c = Math.max(0, Math.min(w - 1, x1));
  const y0c = Math.max(0, Math.min(h - 1, y0));
  const y1c = Math.max(0, Math.min(h - 1, y1));
  const i00 = (y0c * w + x0c) * 4;
  const i10 = (y0c * w + x1c) * 4;
  const i01 = (y1c * w + x0c) * 4;
  const i11 = (y1c * w + x1c) * 4;

  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const a = img.data[i00 + c] * (1 - fx) + img.data[i10 + c] * fx;
    const b = img.data[i01 + c] * (1 - fx) + img.data[i11 + c] * fx;
    out[c] = a * (1 - fy) + b * fy;
  }
  return out;
}

export function toGrayscale(img: RgbaImage): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    // 对黄化/褪色相对不敏感的亮度，同时保留色度边缘的补偿见 edgeEnergy。
    out[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  }
  return out;
}

/**
 * 色度 + 亮度边缘能量。褪色主要改变低频亮度，经纬边界在色度梯度中仍存在。
 * 返回每个像素的水平/竖直梯度能量。
 */
export function edgeEnergy(img: RgbaImage): { gx: Float32Array; gy: Float32Array; mag: Float32Array } {
  const { width: w, height: h, data } = img;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);

  const lum = new Float32Array(w * h);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11;
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const i = p * 4;
      const il = (p - 1) * 4;
      const ir = (p + 1) * 4;
      const iu = (p - w) * 4;
      const id = (p + w) * 4;

      const lxL = lum[p - 1];
      const lxR = lum[p + 1];
      const lyU = lum[p - w];
      const lyD = lum[p + w];
      const dxLum = lxR - lxL;
      const dyLum = lyD - lyU;

      // 简化的 RGB 色度差，避免完整 OKLab 变换进入热点循环。
      const dxChroma =
        Math.abs(data[ir] - data[il]) +
        Math.abs(data[ir + 1] - data[il + 1]) +
        Math.abs(data[ir + 2] - data[il + 2]);
      const dyChroma =
        Math.abs(data[id] - data[iu]) +
        Math.abs(data[id + 1] - data[iu + 1]) +
        Math.abs(data[id + 2] - data[iu + 2]);

      const ex = Math.abs(dxLum) + dxChroma * 0.35;
      const ey = Math.abs(dyLum) + dyChroma * 0.35;
      gx[p] = ex;
      gy[p] = ey;
      mag[p] = ex + ey;
      void i;
    }
  }
  return { gx, gy, mag };
}

/** 快速盒式降采样。6000 万像素原图只做这一次全分辨率扫描。 */
export function downsampleBox(src: RgbaImage, maxEdge: number): RgbaImage {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxEdge) return cloneImage(src);
  const scale = maxEdge / longest;
  const tw = Math.max(1, Math.round(src.width * scale));
  const th = Math.max(1, Math.round(src.height * scale));
  const dst = createImage(tw, th);
  const xRatio = src.width / tw;
  const yRatio = src.height / th;

  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor(ty * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((ty + 1) * yRatio));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor(tx * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((tx + 1) * xRatio));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        let row = (sy * src.width + sx0) * 4;
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          r += src.data[row];
          g += src.data[row + 1];
          b += src.data[row + 2];
          a += src.data[row + 3];
          n++;
          row += 4;
        }
      }
      const di = (ty * tw + tx) * 4;
      dst.data[di] = r / n;
      dst.data[di + 1] = g / n;
      dst.data[di + 2] = b / n;
      dst.data[di + 3] = a / n;
    }
  }
  return dst;
}

/** 只按固定步长取样的极速降采样，适合先估计四角/方向。 */
export function downsampleStride(src: RgbaImage, maxEdge: number): RgbaImage {
  const longest = Math.max(src.width, src.height);
  if (longest <= maxEdge) return cloneImage(src);
  const step = Math.ceil(longest / maxEdge);
  const tw = Math.floor(src.width / step);
  const th = Math.floor(src.height / step);
  const dst = createImage(tw, th);
  for (let y = 0; y < th; y++) {
    const sy = y * step;
    for (let x = 0; x < tw; x++) {
      const sx = x * step;
      const si = (sy * src.width + sx) * 4;
      const di = (y * tw + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

export function imageToCanvas(img: RgbaImage): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d')!;
    const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    ctx.putImageData(data, 0, 0);
    return canvas;
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d')!;
  const data = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(data, 0, 0);
  return canvas;
}

export async function fileToRgba(file: File | Blob, maxEdge?: number): Promise<RgbaImage> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    let targetW = bitmap.width;
    let targetH = bitmap.height;
    if (maxEdge && Math.max(targetW, targetH) > maxEdge) {
      const s = maxEdge / Math.max(targetW, targetH);
      targetW = Math.round(targetW * s);
      targetH = Math.round(targetH * s);
    }
    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();
    return ctx.getImageData(0, 0, targetW, targetH);
  }
  // 测试/旧环境兜底：通过 HTMLImageElement 读取 ObjectURL。
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (maxEdge && Math.max(w, h) > maxEdge) {
      const s = maxEdge / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}
