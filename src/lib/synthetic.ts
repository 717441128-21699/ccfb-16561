import type { DegradationSpec, GroundTruth, PatternKind, Quad, RgbaImage, SampleSpec } from '../types';
import { hexToRgb } from './color';
import { createImage, sampleBilinear } from './image';
import { findHomography, applyHomography } from './geometry';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SEVERITY_PRESETS: Record<string, DegradationSpec> = {
  轻度: { wrinkle: 0.1, oblique: 0.18, fade: 0.22, damage: 0.015, yellow: 0.2, colorBleed: 0.05, seed: 101 },
  中度: { wrinkle: 0.18, oblique: 0.3, fade: 0.38, damage: 0.03, yellow: 0.36, colorBleed: 0.08, seed: 202 },
  重度: { wrinkle: 0.2, oblique: 0.42, fade: 0.38, damage: 0.045, yellow: 0.38, colorBleed: 0.09, seed: 303 },
};

/**
 * 验收套片的退化均为可复现的显式数值。褶皱振幅以“格距倍数”标记，
 * 斜拍/褪色/破洞均为 0..1 强度或面积比例。
 */
export const ACCEPTANCE_DEGRADATION: DegradationSpec = {
  wrinkle: 0.24,
  oblique: 0.32,
  fade: 0.36,
  damage: 0.028,
  yellow: 0.34,
  colorBleed: 0.08,
  seed: 404,
};

const PALETTES: Record<PatternKind, string[]> = {
  'round-flower': ['#1d3168', '#b4312b', '#e2b34a', '#4b9872', '#f1ddb4', '#241c1b'],
  'interlocking-lotus': ['#efe0bd', '#3f8b62', '#b83a4b', '#245b91', '#d5a13c', '#2b2522'],
  cloud: ['#c99a35', '#f0dfb8', '#b3392f', '#2c5f91', '#241f1d'],
  meander: ['#efd6a0', '#9f2d25', '#203e73', '#241f1d'],
  phoenix: ['#4c2364', '#c33a2e', '#e0a83e', '#2f8a78', '#efe0bd', '#241b1b'],
};

const DIMENSIONS: Record<PatternKind, { w: number; h: number }> = {
  'round-flower': { w: 56, h: 56 },
  'interlocking-lotus': { w: 72, h: 44 },
  cloud: { w: 52, h: 52 },
  meander: { w: 64, h: 32 },
  phoenix: { w: 64, h: 56 },
};

export function createSampleSpec(
  kind: PatternKind,
  severity: keyof typeof SEVERITY_PRESETS | DegradationSpec = '中度',
  overrides: Partial<SampleSpec> = {},
): SampleSpec {
  const dims = DIMENSIONS[kind];
  const degradation =
    typeof severity === 'string'
      ? { ...SEVERITY_PRESETS[severity], seed: SEVERITY_PRESETS[severity].seed + Object.keys(DIMENSIONS).indexOf(kind) * 17 }
      : { ...severity };
  const names: Record<PatternKind, string> = {
    'round-flower': '团花镜',
    'interlocking-lotus': '缠枝莲',
    cloud: '如意云纹',
    meander: '万字回纹',
    phoenix: '凤穿牡丹',
  };
  return {
    id: `${kind}-${typeof severity === 'string' ? severity : 'custom'}`,
    name: names[kind],
    kind,
    warpCount: dims.w,
    weftCount: dims.h,
    repeatsX: kind === 'interlocking-lotus' || kind === 'meander' ? 3 : 3,
    repeatsY: kind === 'meander' || kind === 'interlocking-lotus' ? 3 : 3,
    palette: PALETTES[kind],
    degradation,
    longEdge: 1800,
    ...overrides,
  };
}

class Painter {
  cells: Uint8Array;
  constructor(public w: number, public h: number) {
    this.cells = new Uint8Array(w * h);
  }
  idx(x: number, y: number): number {
    return ((y + this.h * 8) % this.h) * this.w + ((x + this.w * 8) % this.w);
  }
  set(x: number, y: number, v: number, wrap = true): void {
    if (!wrap && (x < 0 || y < 0 || x >= this.w || y >= this.h)) return;
    this.cells[this.idx(x, y)] = v;
  }
  rect(x0: number, y0: number, x1: number, y1: number, v: number, wrap = false): void {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, v, wrap);
  }
  disk(cx: number, cy: number, r: number, v: number, wrap = false): void {
    const rr = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d <= rr) this.set(x, y, v, wrap);
      }
    }
  }
  ring(cx: number, cy: number, r0: number, r1: number, v: number): void {
    for (let y = Math.floor(cy - r1); y <= Math.ceil(cy + r1); y++) {
      for (let x = Math.floor(cx - r1); x <= Math.ceil(cx + r1); x++) {
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (d >= r0 && d <= r1) this.set(x, y, v, false);
      }
    }
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, rot: number, v: number): void {
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
      for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
        const dx = x - cx;
        const dy = y - cy;
        const xr = dx * cr + dy * sr;
        const yr = -dx * sr + dy * cr;
        if ((xr * xr) / (rx * rx) + (yr * yr) / (ry * ry) <= 1) this.set(x, y, v, false);
      }
    }
  }
}

function makePatternCells(spec: SampleSpec): Uint8Array {
  const { warpCount: W, weftCount: H, kind } = spec;
  const p = new Painter(W, H);
  p.cells.fill(0);

  if (kind === 'round-flower') {
    const cx = W / 2;
    const cy = H / 2;
    p.disk(cx, cy, 25, 1);
    p.ring(cx, cy, 22.5, 24, 2);
    p.ring(cx, cy, 17.5, 19, 4);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const px = cx + Math.cos(a) * 13;
      const py = cy + Math.sin(a) * 13;
      p.ellipse(px, py, 4.2, 8.5, a + Math.PI / 2, i % 2 ? 2 : 4);
    }
    p.disk(cx, cy, 6.2, 2);
    p.disk(cx, cy, 2.6, 5);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      p.ellipse(cx + Math.cos(a) * 20, cy + Math.sin(a) * 20, 3.2, 7, a + Math.PI / 2, 3);
    }
    // 四角小花，保证循环拼接时有连续地纹但不形成更小平移周期。
    for (const [x, y] of [[7, 7], [W - 8, 7], [7, H - 8], [W - 8, H - 8]]) {
      p.disk(x, y, 3.2, 2);
      p.disk(x, y, 1.3, 5);
    }
  } else if (kind === 'interlocking-lotus') {
    // 周期藤蔓：用全局周期函数绘制，跨边界自然连续。
    for (let x = 0; x < W; x++) {
      const y = H / 2 + Math.sin((x / W) * Math.PI * 4) * H * 0.22;
      for (let t = -1.6; t <= 1.6; t += 0.25) {
        p.set(x, Math.round(y + t), 1);
      }
      const y2 = H / 2 - Math.sin((x / W) * Math.PI * 4) * H * 0.22;
      for (let t = -1.2; t <= 1.2; t += 0.25) p.set(x, Math.round(y2 + t), 1);
    }
    for (let k = 0; k < 3; k++) {
      const cx = 12 + k * 24;
      const cy = H / 2 + (k % 2 ? -7 : 7);
      for (let a = 0; a < 8; a++) {
        const ang = (a / 8) * Math.PI * 2;
        p.ellipse(cx + Math.cos(ang) * 4, cy + Math.sin(ang) * 4, 2.8, 5.2, ang + Math.PI / 2, 2);
      }
      p.disk(cx, cy, 2.8, 4);
      p.disk(cx, cy, 1.2, 5);
      for (let a = 0; a < 4; a++) {
        const ang = Math.PI / 4 + (a * Math.PI) / 2;
        p.disk(cx + Math.cos(ang) * 6.2, cy + Math.sin(ang) * 6.2, 1.7, 3);
      }
      p.ellipse(cx - 8, cy + 4, 3, 6, -0.8, 1);
      p.ellipse(cx + 8, cy - 4, 3, 6, 0.8, 1);
    }
    // 细密菱形地纹。
    for (let y = 2; y < H; y += 6) {
      for (let x = ((y / 6) % 2) * 3; x < W; x += 6) {
        p.set(x, y, 4);
        p.set(x + 1, y, 4);
      }
    }
  } else if (kind === 'cloud') {
    const clouds = [
      { cx: 13, cy: 14, r: 8, main: 1, ornament: 2 },
      { cx: 40, cy: 12, r: 6.5, main: 1, ornament: 3 },
      { cx: 15, cy: 40, r: 7, main: 1, ornament: 3 },
      { cx: 39, cy: 38, r: 9, main: 1, ornament: 2 },
    ];
    for (const c of clouds) {
      const { cx, cy, r } = c;
      p.disk(cx, cy, r, c.main);
      p.disk(cx + 8, cy + 2, r * 0.72, c.main);
      p.disk(cx - 7, cy + 3, r * 0.6, c.main);
      p.disk(cx, cy, r * 0.48, 0);
      p.ring(cx + 1, cy, 2.2, 3.4, c.ornament);
      p.disk(cx + 1, cy, 1.25, 4);
      p.rect(cx - 10, cy + 7, cx + 13, cy + 9, c.main);
      p.rect(cx + 9, cy + 2, cx + 12, cy + 8, c.ornament);
    }
    // 中央太极式团云打破 26 格近似平移，使完整 52 格成为基频。
    p.disk(W / 2, H / 2, 4.2, 2);
    p.disk(W / 2, H / 2, 1.7, 4);
    for (let x = 0; x < W; x += 8) p.rect(x, H - 5, x + 4, H - 4, 3);
  } else if (kind === 'meander') {
    p.rect(0, 0, W - 1, 2, 1);
    p.rect(0, H - 3, W - 1, H - 1, 1);
    p.rect(0, 0, 2, H - 1, 2);
    p.rect(W - 3, 0, W - 1, H - 1, 2);
    // 连续回纹，周期为 16 格；整个循环含 4 个反向连接，因此基频仍是 W。
    for (let base = 5; base < W - 12; base += 16) {
      p.rect(base, 7, base + 10, 9, 1);
      p.rect(base + 8, 7, base + 10, 22, 1);
      p.rect(base + 2, 20, base + 10, 22, 1);
      p.rect(base + 2, 12, base + 4, 21, 1);
      p.rect(base + 2, 12, base + 7, 14, 1);
      p.rect(base + 5, 14, base + 7, 17, 3);
    }
    p.disk(W / 2, H / 2, 3.5, 2);
  } else {
    // phoenix：抽象凤鸟侧影 + 牡丹，强不对称以免误选半周期。
    const cx = W / 2;
    const cy = H / 2 + 2;
    p.ellipse(cx, cy, 15, 8, 0.1, 1);
    p.ring(cx, cy, 14.2, 15.4, 5);
    p.disk(cx + 15, cy - 7, 5, 1);
    p.ring(cx + 15, cy - 7, 4.1, 5.1, 5);
    p.disk(cx + 16.5, cy - 8, 1.8, 5);
    p.set(cx + 20, cy - 8, 2);
    p.set(cx + 21, cy - 8, 2);
    for (let i = 0; i < 5; i++) {
      p.ellipse(cx - 12 - i * 3, cy + 2 + i * 2, 3.2, 12 - i, -0.9 + i * 0.18, i % 2 ? 2 : 3);
    }
    p.ellipse(cx - 2, cy - 8, 5, 10, 0.7, 3);
    for (let a = 0; a < 7; a++) {
      const ang = (a / 7) * Math.PI * 2;
      p.ellipse(14 + Math.cos(ang) * 4, H - 13 + Math.sin(ang) * 4, 3, 5, ang, 2);
    }
    p.disk(14, H - 13, 2.5, 4);
    for (let x = 4; x < W - 4; x += 7) p.set(x, 5 + Math.round(Math.sin(x) * 2), 4);
  }
  return p.cells;
}

function addWeaveAndDye(
  cloth: RgbaImage,
  cells: Uint8Array,
  spec: SampleSpec,
  pitch: number,
  rng: () => number,
): void {
  const palette = spec.palette.map(hexToRgb);
  const W = spec.warpCount;
  const H = spec.weftCount;
  const totalCols = W * spec.repeatsX;
  const totalRows = H * spec.repeatsY;
  const d = spec.degradation;

  for (let y = 0; y < cloth.height; y++) {
    const rowCell = Math.min(totalRows - 1, Math.floor(y / pitch));
    const fy = (y % pitch) / pitch;
    const threadY = 0.8 + 0.34 * Math.sin(Math.PI * fy);
    const gapY = Math.min(fy, 1 - fy) < 0.07 ? 0.72 : 1;
    for (let x = 0; x < cloth.width; x++) {
      const colCell = Math.min(totalCols - 1, Math.floor(x / pitch));
      const fx = (x % pitch) / pitch;
      const threadX = 0.8 + 0.34 * Math.sin(Math.PI * fx);
      const gapX = Math.min(fx, 1 - fx) < 0.07 ? 0.68 : 1;
      const idx = cells[(rowCell % H) * W + (colCell % W)];
      const c = palette[idx];
      const cellVariation = 1 + (((colCell * 17 + rowCell * 31) % 11) - 5) * 0.006;
      const overUnder = (colCell + rowCell) & 1 ? threadX : threadY;
      const shade =
        (threadX * 0.42 + threadY * 0.42 + overUnder * 0.16) * cellVariation * gapX * gapY;
      const noise = (rng() - 0.5) * 8;
      const i = (y * cloth.width + x) * 4;
      cloth.data[i] = c.r * shade + noise;
      cloth.data[i + 1] = c.g * shade + noise;
      cloth.data[i + 2] = c.b * shade + noise;
      cloth.data[i + 3] = 255;
    }
  }

  if (d.colorBleed > 0) {
    const radius = Math.max(1, Math.round(pitch * d.colorBleed * 0.7));
    boxBlurRgba(cloth, radius);
  }

  // 褪色/黄化是低频空间场，不能破坏周期结构。
  for (let y = 0; y < cloth.height; y++) {
    const gy = y / cloth.height;
    for (let x = 0; x < cloth.width; x++) {
      const gx = x / cloth.width;
      const age = d.fade * (0.72 + 0.2 * Math.sin(gx * Math.PI * 2 + 0.7) * Math.sin(gy * Math.PI) + 0.18 * gy);
      const t = Math.max(0, Math.min(0.82, age));
      const i = (y * cloth.width + x) * 4;
      cloth.data[i] = cloth.data[i] * (1 - t) + 229 * t + d.yellow * 10;
      cloth.data[i + 1] = cloth.data[i + 1] * (1 - t) + 211 * t + d.yellow * 4;
      cloth.data[i + 2] = cloth.data[i + 2] * (1 - t) + 166 * t - d.yellow * 12;
    }
  }
}

function boxBlurRgba(img: RgbaImage, radius: number): void {
  if (radius < 1) return;
  const tmp = new Uint8ClampedArray(img.data.length);
  const w = img.width;
  const h = img.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.max(0, Math.min(w - 1, x + k));
        const i = (y * w + xx) * 4;
        r += img.data[i];
        g += img.data[i + 1];
        b += img.data[i + 2];
        n++;
      }
      const j = (y * w + x) * 4;
      tmp[j] = r / n;
      tmp[j + 1] = g / n;
      tmp[j + 2] = b / n;
      tmp[j + 3] = 255;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.max(0, Math.min(h - 1, y + k));
        const i = (yy * w + x) * 4;
        r += tmp[i];
        g += tmp[i + 1];
        b += tmp[i + 2];
        n++;
      }
      const j = (y * w + x) * 4;
      img.data[j] = r / n;
      img.data[j + 1] = g / n;
      img.data[j + 2] = b / n;
    }
  }
}

function addDamage(cloth: RgbaImage, spec: SampleSpec, pitch: number, rng: () => number): void {
  const d = spec.degradation;
  const cellArea = pitch * pitch;
  const targetPixels = d.damage * cloth.width * cloth.height;
  const blobCount = Math.max(2, Math.round(targetPixels / (cellArea * 2.2)));
  for (let b = 0; b < blobCount; b++) {
    const cx = rng() * cloth.width;
    const cy = rng() * cloth.height;
    const rx = pitch * (0.25 + rng() * 1.25);
    const ry = pitch * (0.25 + rng() * 1.05);
    const hole = rng() < 0.48;
    const alpha = hole ? 0.82 + rng() * 0.16 : 0.16 + rng() * 0.22;
    const cr = hole ? 22 + rng() * 20 : 105 + rng() * 45;
    const cg = hole ? 18 + rng() * 14 : 72 + rng() * 35;
    const cb = hole ? 16 + rng() * 12 : 30 + rng() * 20;
    const x0 = Math.max(0, Math.floor(cx - rx - 2));
    const x1 = Math.min(cloth.width - 1, Math.ceil(cx + rx + 2));
    const y0 = Math.max(0, Math.floor(cy - ry - 2));
    const y1 = Math.min(cloth.height - 1, Math.ceil(cy + ry + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        if (e > 1) continue;
        const fringe = e > 0.72 ? 0.35 : 1;
        const a = alpha * fringe;
        const i = (y * cloth.width + x) * 4;
        cloth.data[i] = cloth.data[i] * (1 - a) + cr * a;
        cloth.data[i + 1] = cloth.data[i + 1] * (1 - a) + cg * a;
        cloth.data[i + 2] = cloth.data[i + 2] * (1 - a) + cb * a;
      }
    }
  }
}

function makeWrinkled(cloth: RgbaImage, spec: SampleSpec, pitch: number): RgbaImage {
  const d = spec.degradation;
  const out = createImage(cloth.width, cloth.height);
  const rng = mulberry32(d.seed + 999);
  const ampX = d.wrinkle * pitch * 1.15;
  const ampY = d.wrinkle * pitch * 0.82;
  const periodY = cloth.height / (2.2 + rng() * 0.8);
  const periodX = cloth.width / (2.6 + rng() * 0.9);
  const phase1 = rng() * Math.PI * 2;
  const phase2 = rng() * Math.PI * 2;

  for (let y = 0; y < cloth.height; y++) {
    for (let x = 0; x < cloth.width; x++) {
      const sx =
        x -
        ampX * Math.sin((2 * Math.PI * y) / periodY + phase1) -
        ampX * 0.28 * Math.sin((2 * Math.PI * y) / (periodY * 0.47) + phase2);
      const sy =
        y -
        ampY * Math.sin((2 * Math.PI * x) / periodX + phase2) -
        ampY * 0.22 * Math.sin((2 * Math.PI * x) / (periodX * 0.53) + phase1);
      const rgba = sampleBilinear(cloth, sx, sy);
      const i = (y * cloth.width + x) * 4;
      out.data[i] = rgba[0];
      out.data[i + 1] = rgba[1];
      out.data[i + 2] = rgba[2];
      out.data[i + 3] = 255;
    }
  }
  return out;
}

function makePhotoQuad(spec: SampleSpec, photoW: number, photoH: number, clothW: number, clothH: number): Quad {
  const fit = Math.min((photoW * 0.84) / clothW, (photoH * 0.82) / clothH);
  const bw = clothW * fit;
  const bh = clothH * fit;
  const o = spec.degradation.oblique;
  const rng = mulberry32(spec.degradation.seed + 77);
  const angle = ((rng() < 0.5 ? -1 : 1) * (3 + o * 9) * Math.PI) / 180;
  const cx = photoW / 2 + (rng() - 0.5) * photoW * 0.025;
  const cy = photoH / 2 + (rng() - 0.5) * photoH * 0.025;

  const raw: Quad = {
    tl: { x: -bw / 2 - o * bw * 0.035, y: -bh / 2 + o * bh * 0.13 },
    tr: { x: bw / 2 - o * bw * 0.13, y: -bh / 2 - o * bh * 0.04 },
    br: { x: bw / 2 + o * bw * 0.07, y: bh / 2 + o * bh * 0.1 },
    bl: { x: -bw / 2 + o * bw * 0.04, y: bh / 2 - o * bh * 0.12 },
  };
  const rot = (p: { x: number; y: number }) => ({
    x: cx + p.x * Math.cos(angle) - p.y * Math.sin(angle),
    y: cy + p.x * Math.sin(angle) + p.y * Math.cos(angle),
  });
  return { tl: rot(raw.tl), tr: rot(raw.tr), br: rot(raw.br), bl: rot(raw.bl) };
}

function warpClothToPhoto(cloth: RgbaImage, quad: Quad, photoW: number, photoH: number, seed: number): RgbaImage {
  const photo = createImage(photoW, photoH);
  const clothCorners = [
    { x: 0, y: 0 },
    { x: cloth.width - 1, y: 0 },
    { x: cloth.width - 1, y: cloth.height - 1 },
    { x: 0, y: cloth.height - 1 },
  ];
  const h = findHomography([quad.tl, quad.tr, quad.br, quad.bl], clothCorners);
  const rng = mulberry32(seed + 31);

  for (let y = 0; y < photoH; y++) {
    const bgGrad = 28 + (y / photoH) * 12;
    for (let x = 0; x < photoW; x++) {
      const p = applyHomography(h, x, y);
      const i = (y * photoW + x) * 4;
      if (p.x >= 0 && p.y >= 0 && p.x < cloth.width - 1 && p.y < cloth.height - 1) {
        const c = sampleBilinear(cloth, p.x, p.y);
        photo.data[i] = c[0];
        photo.data[i + 1] = c[1];
        photo.data[i + 2] = c[2];
      } else {
        const n = (rng() - 0.5) * 10;
        photo.data[i] = bgGrad * 0.92 + n;
        photo.data[i + 1] = bgGrad * 0.82 + n;
        photo.data[i + 2] = bgGrad * 0.7 + n;
      }
      photo.data[i + 3] = 255;
    }
  }
  return photo;
}

export interface GeneratedSample extends GroundTruth {
  image: RgbaImage;
}

export function generateSample(spec: SampleSpec): GeneratedSample {
  const pitch = 14;
  const clothWidth = spec.warpCount * spec.repeatsX * pitch;
  const clothHeight = spec.weftCount * spec.repeatsY * pitch;
  const cells = makePatternCells(spec);

  const cloth = createImage(clothWidth, clothHeight);
  addWeaveAndDye(cloth, cells, spec, pitch, mulberry32(spec.degradation.seed));
  addDamage(cloth, spec, pitch, mulberry32(spec.degradation.seed + 3));
  const wrinkled = makeWrinkled(cloth, spec, pitch);

  const aspect = clothWidth / clothHeight;
  let photoW: number;
  let photoH: number;
  if (aspect >= 1) {
    photoW = spec.longEdge;
    const bw = photoW * 0.84;
    const bh = bw / aspect;
    photoH = Math.ceil(bh / 0.82);
  } else {
    photoH = spec.longEdge;
    const bh = photoH * 0.82;
    const bw = bh * aspect;
    photoW = Math.ceil(bw / 0.84);
  }

  const photoQuad = makePhotoQuad(spec, photoW, photoH, clothWidth, clothHeight);
  const image = warpClothToPhoto(wrinkled, photoQuad, photoW, photoH, spec.degradation.seed);

  return {
    spec,
    cells,
    photoQuad,
    clothWidth,
    clothHeight,
    pitch,
    image,
  };
}

/**
 * 从一张较小样片构造 6000 万像素级性能图。
 * 使用最近邻平铺放大，保留算法需要处理的像素总量和四边形坐标尺度；
 * 验收准确度仍由原始分辨率合成样片负责。
 */
export function upscaleForPerformance(src: GeneratedSample, targetMegapixels = 60): { image: RgbaImage; quad: Quad } {
  const targetPixels = targetMegapixels * 1_000_000;
  const scale = Math.sqrt(targetPixels / (src.image.width * src.image.height));
  const width = Math.round(src.image.width * scale);
  const height = Math.round(src.image.height * scale);
  const image = createImage(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.image.width - 1, Math.floor(x / scale));
      const si = (sy * src.image.width + sx) * 4;
      const di = (y * width + x) * 4;
      image.data[di] = src.image.data[si];
      image.data[di + 1] = src.image.data[si + 1];
      image.data[di + 2] = src.image.data[si + 2];
      image.data[di + 3] = 255;
    }
  }
  const qScaleX = width / src.image.width;
  const qScaleY = height / src.image.height;
  const sc = (p: { x: number; y: number }): { x: number; y: number } => ({ x: p.x * qScaleX, y: p.y * qScaleY });
  return {
    image,
    quad: {
      tl: sc(src.photoQuad.tl),
      tr: sc(src.photoQuad.tr),
      br: sc(src.photoQuad.br),
      bl: sc(src.photoQuad.bl),
    },
  };
}
