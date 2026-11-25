// 领域模型与 Worker 消息类型。核心算法只依赖这些可结构化克隆的数据，
// 因此同一份管线既能在浏览器 Worker 中运行，也能在 Node 验收测试中运行。

export interface Point {
  x: number;
  y: number;
}

export interface Quad {
  tl: Point;
  tr: Point;
  br: Point;
  bl: Point;
}

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export type PatternKind =
  | 'round-flower'
  | 'interlocking-lotus'
  | 'cloud'
  | 'meander'
  | 'phoenix';

export interface DegradationSpec {
  /** 褶皱位移幅度，按一个经纬格边长的倍数标记，例如 0.35。 */
  wrinkle: number;
  /** 斜拍/透视强度，0 为正拍，1 为强透视。 */
  oblique: number;
  /** 褪色比例 0..1。 */
  fade: number;
  /** 破洞和污渍占布面面积比例 0..1。 */
  damage: number;
  /** 黄化程度 0..1。 */
  yellow: number;
  /** 相邻颜色光学混合/模糊半径，单位为格。 */
  colorBleed: number;
  seed: number;
}

export interface SampleSpec {
  id: string;
  name: string;
  kind: PatternKind;
  /** 一个完整循环中的经丝根数（格数）。 */
  warpCount: number;
  /** 一个完整循环中的纬丝根数（格数）。 */
  weftCount: number;
  /** 横向、纵向拍摄到的循环数。 */
  repeatsX: number;
  repeatsY: number;
  palette: string[];
  degradation: DegradationSpec;
  /** 生成照片的长边像素；6000 万像素性能测试会单独放大。 */
  longEdge: number;
}

export interface GroundTruth {
  spec: SampleSpec;
  /** 长度 warpCount * weftCount，值为 palette 下标。 */
  cells: Uint8Array;
  /** 生成照片中布面四角，供 UI 初始化和无 DOM 测试使用。 */
  photoQuad: Quad;
  /** 拉平后理想布面尺寸。 */
  clothWidth: number;
  clothHeight: number;
  /** 每格在拉平图中的像素边长。 */
  pitch: number;
}

export interface StraightenOptions {
  quad: Quad;
  outputMaxEdge?: number;
  /** 局部褶皱校正强度 0..1。 */
  dewarpStrength?: number;
  /** 估计条带高度，单位为拉平图像素。 */
  bandSize?: number;
}

export interface WrinkleField {
  /** 每个水平条带对应的横向位移，长度为条带数。 */
  shiftX: Float32Array;
  /** 每个竖直条带对应的纵向位移，长度为条带数。 */
  shiftY: Float32Array;
  bandSize: number;
  referenceY: number;
  referenceX: number;
}

export interface StraightenResult {
  image: RgbaImage;
  width: number;
  height: number;
  homography: number[];
  wrinkle: WrinkleField;
  quad: Quad;
}

export interface GridGeometry {
  /** 整张拉平图估计到的经纬格总数。 */
  totalCols: number;
  totalRows: number;
  /** 第一格中心。 */
  originX: number;
  originY: number;
  pitchX: number;
  pitchY: number;
}

export interface RepeatInfo {
  /** 一个循环单元的经丝根数。 */
  warpCount: number;
  /** 一个循环单元的纬丝根数。 */
  weftCount: number;
  /** 整张图中完整/近似完整循环数。 */
  repeatsX: number;
  repeatsY: number;
  /** 循环在整幅格阵中的起始格。 */
  offsetCol: number;
  offsetRow: number;
  grid: GridGeometry;
  /** 0..1，越高越可信。 */
  confidence: number;
}

export interface PaletteColor {
  r: number;
  g: number;
  b: number;
  name: string;
}

export interface PatternResult {
  width: number;
  height: number;
  /** 长度 width*height，调色板下标。 */
  indices: Uint8Array;
  palette: PaletteColor[];
  /** 每色格数。 */
  usage: number[];
  /** 每格置信度 0..1。 */
  confidence: Float32Array;
  /** 叠合时实际使用的循环数。 */
  mergedRepeats: number;
}

export interface PipelineOptions {
  colorCount: number;
  initialQuad?: Quad;
  straighten?: Partial<StraightenOptions>;
  repeat?: {
    minPeriod?: number;
    maxPeriod?: number;
  };
  /** 每根纬丝对应多少米，用于估算用量；不填只给格数。 */
  weftLengthPerCellM?: number;
}

export interface PipelineResult {
  straight: StraightenResult;
  repeat: RepeatInfo;
  pattern: PatternResult;
  timings: Record<string, number>;
}

export type WorkerRequest =
  | { id: number; type: 'generateSample'; spec: SampleSpec }
  | { id: number; type: 'estimateQuad'; image: RgbaImage }
  | { id: number; type: 'straighten'; image: RgbaImage; options: StraightenOptions }
  | {
      id: number;
      type: 'detectRepeat';
      image: RgbaImage;
      grid?: GridGeometry;
    }
  | {
      id: number;
      type: 'buildPattern';
      image: RgbaImage;
      repeat: RepeatInfo;
      colorCount: number;
    }
  | {
      id: number;
      type: 'pipeline';
      image: RgbaImage;
      options: PipelineOptions;
      initialQuad?: Quad;
    };

export type WorkerResponse =
  | { id: number; ok: true; type: string; result: unknown }
  | { id: number; ok: false; error: string };
