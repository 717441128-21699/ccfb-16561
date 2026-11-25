import type { PaletteColor } from '../types';

export function clamp(v: number, min = 0, max = 255): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function hexToRgb(hex: string): PaletteColor {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
    name: hex,
  };
}

export function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.round(clamp(v)).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** sRGB -> OKLab，对褪色/黄化后的感知距离比直接 RGB 欧氏距离稳定。 */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const sr = r / 255;
  const sg = g / 255;
  const sb = b / 255;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lr = lin(sr);
  const lg = lin(sg);
  const lb = lin(sb);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

export function colorDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const la = rgbToOklab(a.r, a.g, a.b);
  const lb = rgbToOklab(b.r, b.g, b.b);
  const dl = la[0] - lb[0];
  const da = la[1] - lb[1];
  const db = la[2] - lb[2];
  // 色相/色度权重略高，避免褪色后邻近传统色被亮度拉到一起。
  return Math.sqrt(dl * dl * 1.1 + da * da * 1.35 + db * db * 1.35);
}

export function nearestPaletteIndex(
  rgb: { r: number; g: number; b: number },
  palette: PaletteColor[],
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = colorDistance(rgb, palette[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 对一组像素做逐通道中位数；比平均值更能抵抗破洞、污渍和高光。 */
export function medianRgb(samples: ArrayLike<number>[], channelOffset = 0): { r: number; g: number; b: number } {
  if (samples.length === 0) return { r: 0, g: 0, b: 0 };
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const s of samples) {
    rs.push(s[channelOffset]);
    gs.push(s[channelOffset + 1]);
    bs.push(s[channelOffset + 2]);
  }
  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const mid = rs.length >> 1;
  if (rs.length & 1) {
    return { r: rs[mid], g: gs[mid], b: bs[mid] };
  }
  return {
    r: (rs[mid - 1] + rs[mid]) / 2,
    g: (gs[mid - 1] + gs[mid]) / 2,
    b: (bs[mid - 1] + bs[mid]) / 2,
  };
}

export const TRADITIONAL_COLOR_NAMES = [
  '绛红',
  '石青',
  '石绿',
  '藤黄',
  '赭石',
  '紫绛',
  '湖蓝',
  '牙白',
  '墨黑',
  '鎏金',
  '黛蓝',
  '胭脂',
];

export function namePaletteColor(rgb: { r: number; g: number; b: number }, index: number): string {
  // 先给稳定的传统色名；导出时仍保留 HEX，避免不同显示设备歧义。
  const named: PaletteColor[] = [
    { r: 139, g: 26, b: 34, name: '绛红' },
    { r: 29, g: 74, b: 138, name: '石青' },
    { r: 42, g: 128, b: 92, name: '石绿' },
    { r: 214, g: 169, b: 65, name: '藤黄' },
    { r: 139, g: 82, b: 48, name: '赭石' },
    { r: 91, g: 45, b: 99, name: '紫绛' },
    { r: 72, g: 145, b: 178, name: '湖蓝' },
    { r: 232, g: 220, b: 188, name: '牙白' },
    { r: 35, g: 31, b: 32, name: '墨黑' },
    { r: 198, g: 146, b: 54, name: '鎏金' },
  ];
  let bestName = TRADITIONAL_COLOR_NAMES[index % TRADITIONAL_COLOR_NAMES.length];
  let bestD = Infinity;
  for (const n of named) {
    const d = colorDistance(rgb, n);
    if (d < bestD) {
      bestD = d;
      bestName = n.name;
    }
  }
  return bestD < 0.12 ? bestName : `${bestName}${index + 1}`;
}
