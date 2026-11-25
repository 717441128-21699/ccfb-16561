import './styles.css';
import type {
  PatternResult,
  Point,
  Quad,
  RepeatInfo,
  RgbaImage,
  SampleSpec,
  StraightenResult,
  WorkerRequest,
  WorkerResponse,
} from './types';
import { createSampleSpec, type GeneratedSample, SEVERITY_PRESETS } from './lib/synthetic';
import { fileToRgba } from './lib/image';
import { PatternEditor } from './ui/editor';
import PipelineWorker from './workers/pipeline.worker?worker';

type Page = 'import' | 'straighten' | 'repeat' | 'edit';

interface AppState {
  page: Page;
  source?: RgbaImage;
  fileName?: string;
  groundTruth?: GeneratedSample;
  quad?: Quad;
  straight?: StraightenResult;
  repeat?: RepeatInfo;
  pattern?: PatternResult;
  colorCount: number;
  weftMmPerCell: number;
  busy: boolean;
}

const state: AppState = {
  page: 'import',
  colorCount: 6,
  weftMmPerCell: 0.2,
  busy: false,
};

const worker = new PipelineWorker();
let requestId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const response = event.data;
  const item = pending.get(response.id);
  if (!item) return;
  pending.delete(response.id);
  if (response.ok) item.resolve(response.result);
  else item.reject(new Error(response.error));
};

worker.onerror = (event) => {
  console.error(event);
  toast('计算 Worker 出错，请查看控制台');
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function callWorker<T>(request: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
  const id = requestId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    worker.postMessage({ ...request, id } as WorkerRequest);
  });
}

const main = document.querySelector<HTMLElement>('#main')!;
const toastEl = document.querySelector<HTMLElement>('#toast')!;
let toastTimer: number | undefined;

function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 3200);
}

function h<T extends HTMLElement = HTMLElement>(html: string): T {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild as T;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function paintRgba(canvas: HTMLCanvasElement, image: RgbaImage): void {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const copy = new Uint8ClampedArray(image.data.length);
  copy.set(image.data);
  ctx.putImageData(new ImageData(copy, image.width, image.height), 0, 0);
}

function setBusy(busy: boolean, label = '计算中…'): void {
  state.busy = busy;
  let overlay = document.querySelector<HTMLElement>('.busy-overlay');
  if (busy) {
    if (!overlay) {
      overlay = h<HTMLDivElement>(`<div class="busy-overlay"><div class="spinner"></div><p>${label}</p></div>`);
      document.body.appendChild(overlay);
    }
  } else {
    overlay?.remove();
  }
}

function go(page: Page): void {
  state.page = page;
  document.querySelectorAll<HTMLButtonElement>('.step').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.page === page);
  });
  render();
}

document.querySelectorAll<HTMLButtonElement>('.step').forEach((btn) => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page as Page;
    if (page !== 'import' && !state.source) {
      toast('请先导入照片或生成测试样片');
      return;
    }
    if ((page === 'repeat' || page === 'edit') && !state.straight) {
      toast('请先完成经纬拉平');
      go('straighten');
      return;
    }
    if (page === 'edit' && !state.pattern) {
      toast('请先在循环单元页执行归色');
      go('repeat');
      return;
    }
    go(page);
  });
});

function render(): void {
  if (state.page === 'import') renderImport();
  if (state.page === 'straighten') renderStraighten();
  if (state.page === 'repeat') renderRepeat();
  if (state.page === 'edit') renderEdit();
}

/* ---------------------------------- 导入页 --------------------------------- */

function renderImport(): void {
  main.innerHTML = `
    <section class="page import-page">
      <div class="hero-card">
        <div>
          <p class="eyebrow">Silk jacquard reconstruction</p>
          <h2>从褶皱、斜拍和褪色照片，到可上机的格子意匠图</h2>
          <p class="lead">系统按经纬走向校正透视与褶皱，利用纹样循环叠合去除破洞污渍，再按纬线配色数归色。拉平、找循环和归色均在 Web Worker 中运行。</p>
          <div class="hero-actions">
            <button class="primary" id="pickFile">导入文物照片</button>
            <label class="color-count">纬线配色数
              <input id="colorCountTop" type="number" min="2" max="16" value="${state.colorCount}" />
            </label>
          </div>
          <input id="fileInput" type="file" accept="image/*" hidden />
          <div id="dropzone" class="dropzone">拖拽照片到此处，或点击选择；建议使用长边 2000–9000 像素的原图</div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="weave"></div>
          <div class="grid-swatch"></div>
        </div>
      </div>

      <div class="section-head">
        <div>
          <h3>自检样片库</h3>
          <p>按团花、缠枝莲、云纹、回纹和凤纹自动造片；每张样片的褶皱、斜拍、褪色、破洞、黄化和混色程度均写入元数据。</p>
        </div>
      </div>
      <div class="sample-layout">
        <div class="sample-groups" id="sampleGroups"></div>
        <div class="card current-card">
          <h3>当前照片</h3>
          <div id="importPreview" class="preview-box empty">尚未导入</div>
          <div id="importMeta" class="meta"></div>
          <button class="primary wide" id="toStraighten" disabled>进入经纬拉平</button>
        </div>
      </div>
    </section>`;

  const input = main.querySelector<HTMLInputElement>('#fileInput')!;
  main.querySelector<HTMLButtonElement>('#pickFile')!.addEventListener('click', () => input.click());
  const dropzone = main.querySelector<HTMLDivElement>('#dropzone')!;
  dropzone.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (file) await loadFile(file);
  });
  ['dragover', 'dragenter'].forEach((type) => dropzone.addEventListener(type, (e) => e.preventDefault()));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) await loadFile(file);
  });
  main.querySelector<HTMLInputElement>('#colorCountTop')!.addEventListener('change', (e) => {
    state.colorCount = Number((e.target as HTMLInputElement).value) || 6;
  });
  main.querySelector<HTMLButtonElement>('#toStraighten')!.addEventListener('click', () => go('straighten'));

  const groups = main.querySelector<HTMLElement>('#sampleGroups')!;
  const kinds: Array<{ kind: SampleSpec['kind']; name: string; desc: string }> = [
    { kind: 'round-flower', name: '团花镜', desc: '放射对称团花与四角小花' },
    { kind: 'interlocking-lotus', name: '缠枝莲', desc: '横向波浪藤蔓和连续莲花' },
    { kind: 'cloud', name: '如意云纹', desc: '四朵大小不同的如意云' },
    { kind: 'meander', name: '万字回纹', desc: '几何连续回纹与中心花' },
    { kind: 'phoenix', name: '凤穿牡丹', desc: '强不对称凤鸟、尾羽与牡丹' },
  ];
  for (const item of kinds) {
    const card = h<HTMLElement>(`
      <article class="card sample-card">
        <div class="sample-title"><h4>${item.name}</h4><span>${item.kind}</span></div>
        <p>${item.desc}</p>
        <div class="sample-actions">
          ${Object.keys(SEVERITY_PRESETS)
            .map((level) => `<button data-kind="${item.kind}" data-level="${level}">${level}</button>`)
            .join('')}
        </div>
      </article>`);
    groups.appendChild(card);
  }
  groups.querySelectorAll<HTMLButtonElement>('button[data-kind]').forEach((btn) => {
    btn.addEventListener('click', () => loadSample(btn.dataset.kind as SampleSpec['kind'], btn.dataset.level as keyof typeof SEVERITY_PRESETS));
  });

  refreshImportPreview();
}

async function loadFile(file: File): Promise<void> {
  setBusy(true, '解码照片并估计布面四角…');
  try {
    state.source = await fileToRgba(file, 2400);
    state.fileName = file.name;
    state.groundTruth = undefined;
    state.quad = await callWorker<Quad>({ type: 'estimateQuad', image: state.source });
    state.straight = undefined;
    state.repeat = undefined;
    state.pattern = undefined;
    refreshImportPreview();
    toast('照片已导入，可在拉平页拖动四角校正');
  } catch (error) {
    toast(`导入失败：${(error as Error).message}`);
  } finally {
    setBusy(false);
  }
}

async function loadSample(kind: SampleSpec['kind'], level: keyof typeof SEVERITY_PRESETS): Promise<void> {
  setBusy(true, 'Worker 正在织造带退化的测试样片…');
  try {
    const spec = createSampleSpec(kind, level, { longEdge: 1700 });
    const sample = await callWorker<GeneratedSample>({ type: 'generateSample', spec });
    state.groundTruth = sample;
    state.source = sample.image;
    state.quad = sample.photoQuad;
    state.colorCount = spec.palette.length;
    state.fileName = `${spec.name}-${level}.png`;
    state.straight = undefined;
    state.repeat = undefined;
    state.pattern = undefined;
    refreshImportPreview();
    toast(`已生成 ${spec.name}（${level}）：${spec.warpCount}×${spec.weftCount} 格循环`);
  } catch (error) {
    toast(`样片生成失败：${(error as Error).message}`);
  } finally {
    setBusy(false);
  }
}

function refreshImportPreview(): void {
  const box = document.querySelector<HTMLElement>('#importPreview');
  const meta = document.querySelector<HTMLElement>('#importMeta');
  const btn = document.querySelector<HTMLButtonElement>('#toStraighten');
  if (!box || !meta || !btn) return;
  if (!state.source) {
    box.classList.add('empty');
    box.textContent = '尚未导入';
    meta.innerHTML = '';
    btn.disabled = true;
    return;
  }
  box.classList.remove('empty');
  box.innerHTML = '<canvas id="importCanvas"></canvas>';
  paintRgba(box.querySelector('canvas')!, state.source);
  btn.disabled = false;
  const d = state.groundTruth?.spec.degradation;
  meta.innerHTML = `
    <dl>
      <div><dt>文件</dt><dd>${state.fileName ?? '上传照片'}</dd></div>
      <div><dt>分辨率</dt><dd>${state.source.width} × ${state.source.height}</dd></div>
      ${state.groundTruth ? `<div><dt>人工循环</dt><dd>${state.groundTruth.spec.warpCount} 经 × ${state.groundTruth.spec.weftCount} 纬</dd></div>` : ''}
      ${d ? `<div class="degrade"><dt>退化标记</dt><dd>褶皱 ${d.wrinkle.toFixed(2)} 格 · 斜拍 ${d.oblique.toFixed(2)} · 褪色 ${d.fade.toFixed(2)} · 破洞 ${d.damage.toFixed(3)} · 黄化 ${d.yellow.toFixed(2)}</dd></div>` : ''}
    </dl>`;
}

/* --------------------------------- 拉平页 ---------------------------------- */

let dragCorner: keyof Quad | null = null;

function renderStraighten(): void {
  if (!state.source || !state.quad) {
    main.innerHTML = emptyState('还没有照片', '先到导入页上传或生成测试样片。');
    return;
  }
  main.innerHTML = `
    <section class="page">
      <div class="page-title">
        <div><h2>经纬拉平</h2><p>拖动布面四角对准文物照片中的织锦边缘；Worker 会做透视反投影，并估计缓慢褶皱位移场。</p></div>
        <div class="actions"><button id="autoQuad">重新自动估角</button><button class="primary" id="runStraight">执行拉平</button><button id="toRepeat" ${state.straight ? '' : 'disabled'}>下一步：循环单元 →</button></div>
      </div>
      <div class="two-col">
        <div class="card">
          <h3>原图与布面四角</h3>
          <div class="canvas-frame quad-frame">
            <canvas id="sourceBase"></canvas>
            <canvas id="quadOverlay"></canvas>
          </div>
          <div class="hint">拖动圆点调整四角；斜拍和透视会在反投影后拉直。</div>
        </div>
        <div class="card">
          <h3>拉平结果</h3>
          <div class="canvas-frame result-frame"><canvas id="straightCanvas"></canvas><div id="straightEmpty" class="canvas-empty">尚未执行</div></div>
          <label class="slider">褶皱局部校正强度（实验）
            <input id="dewarpStrength" type="range" min="0" max="1" step="0.05" value="0" />
            <output>0</output>
          </label>
          <p class="hint">正式流程默认使用循环叠合时的局部格点对齐，避免条带匹配在强纹样上累积漂移。</p>
        </div>
      </div>
    </section>`;

  const base = main.querySelector<HTMLCanvasElement>('#sourceBase')!;
  const overlay = main.querySelector<HTMLCanvasElement>('#quadOverlay')!;
  paintRgba(base, state.source);
  overlay.width = state.source.width;
  overlay.height = state.source.height;
  drawQuadOverlay();

  overlay.addEventListener('pointerdown', (e) => {
    const p = eventToImage(e, overlay);
    if (!p || !state.quad) return;
    const entries = Object.entries(state.quad) as Array<[keyof Quad, Point]>;
    const scale = overlay.width / overlay.getBoundingClientRect().width;
    const hitRadius = 22 * scale;
    const hit = entries.find(([, q]) => Math.hypot(q.x - p.x, q.y - p.y) <= hitRadius);
    if (hit) {
      dragCorner = hit[0];
      overlay.setPointerCapture(e.pointerId);
    }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!dragCorner || !state.quad) return;
    const p = eventToImage(e, overlay);
    if (!p) return;
    state.quad[dragCorner] = {
      x: Math.max(0, Math.min(state.source!.width, p.x)),
      y: Math.max(0, Math.min(state.source!.height, p.y)),
    };
    drawQuadOverlay();
  });
  const stopDrag = (e: PointerEvent): void => {
    dragCorner = null;
    if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
  };
  overlay.addEventListener('pointerup', stopDrag);
  overlay.addEventListener('pointercancel', stopDrag);

  main.querySelector<HTMLButtonElement>('#autoQuad')!.addEventListener('click', async () => {
    setBusy(true, 'Worker 检测布面轮廓…');
    try {
      state.quad = await callWorker<Quad>({ type: 'estimateQuad', image: state.source! });
      drawQuadOverlay();
      toast('已重新估计四角，可继续手动修正');
    } finally {
      setBusy(false);
    }
  });

  const strengthInput = main.querySelector<HTMLInputElement>('#dewarpStrength')!;
  const output = main.querySelector<HTMLOutputElement>('output')!;
  strengthInput.addEventListener('input', () => (output.value = strengthInput.value));

  main.querySelector<HTMLButtonElement>('#runStraight')!.addEventListener('click', async () => {
    setBusy(true, 'Worker 正在透视校正、估计经纬周期和褶皱场…');
    try {
      const strength = Number(strengthInput.value);
      state.straight = await callWorker<StraightenResult>({
        type: 'straighten',
        image: state.source!,
        options: { quad: state.quad!, outputMaxEdge: 1800, dewarpStrength: strength },
      });
      const canvas = main.querySelector<HTMLCanvasElement>('#straightCanvas')!;
      paintRgba(canvas, state.straight.image);
      main.querySelector<HTMLElement>('#straightEmpty')?.remove();
      const next = main.querySelector<HTMLButtonElement>('#toRepeat')!;
      next.disabled = false;
      toast(`拉平完成：${state.straight.width}×${state.straight.height}`);
    } catch (error) {
      toast(`拉平失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  });

  main.querySelector<HTMLButtonElement>('#toRepeat')!.addEventListener('click', () => {
    if (state.straight) go('repeat');
  });

  if (state.straight) {
    const canvas = main.querySelector<HTMLCanvasElement>('#straightCanvas')!;
    paintRgba(canvas, state.straight.image);
    main.querySelector<HTMLElement>('#straightEmpty')?.remove();
  }
}

function eventToImage(event: PointerEvent, canvas: HTMLCanvasElement): Point | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return null;
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function drawQuadOverlay(): void {
  const overlay = document.querySelector<HTMLCanvasElement>('#quadOverlay');
  if (!overlay || !state.quad) return;
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const q = state.quad;
  ctx.beginPath();
  ctx.moveTo(q.tl.x, q.tl.y);
  ctx.lineTo(q.tr.x, q.tr.y);
  ctx.lineTo(q.br.x, q.br.y);
  ctx.lineTo(q.bl.x, q.bl.y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(190,40,30,.08)';
  ctx.fill();
  ctx.strokeStyle = '#e33b2e';
  ctx.lineWidth = Math.max(2, overlay.width / 650);
  ctx.setLineDash([overlay.width / 90, overlay.width / 130]);
  ctx.stroke();
  ctx.setLineDash([]);
  const radius = overlay.width / 45;
  for (const [key, p] of Object.entries(q) as Array<[keyof Quad, Point]>) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#fff8e8';
    ctx.fill();
    ctx.lineWidth = radius * 0.28;
    ctx.strokeStyle = '#b3261e';
    ctx.stroke();
    ctx.fillStyle = '#7a1c16';
    ctx.font = `${radius}px system-ui`;
    ctx.fillText(key === 'tl' ? '经' : key === 'tr' ? '纬' : key === 'br' ? '格' : '正', p.x + radius * 1.2, p.y - radius);
  }
}

/* --------------------------------- 循环页 ---------------------------------- */

function renderRepeat(): void {
  if (!state.straight) {
    main.innerHTML = emptyState('还没有拉平图', '请先在拉平页执行校正。');
    return;
  }
  if (!state.repeat) {
    // 进入页面时自动寻找一次。
    void detectRepeat();
  }

  main.innerHTML = `
    <section class="page">
      <div class="page-title">
        <div><h2>循环单元</h2><p>系统在经纬格阵上寻找纹样基频；可直接修改一个循环的经丝根数、纬丝根数和起始偏移。</p></div>
        <div class="actions">
          <button id="redetect">重新自动找循环</button>
          <button class="primary" id="buildPattern">叠合去污并归色 →</button>
        </div>
      </div>
      <div class="repeat-layout">
        <div class="card">
          <h3>拉平图与完整循环框</h3>
          <div class="canvas-frame repeat-frame">
            <canvas id="repeatBase"></canvas>
            <canvas id="repeatOverlay"></canvas>
          </div>
        </div>
        <aside class="card repeat-controls">
          <h3>循环参数</h3>
          <div id="repeatForm" class="form-grid">
            ${numberField('warpCount', '一个循环的经丝根数', state.repeat?.warpCount ?? 0, 4, 2048)}
            ${numberField('weftCount', '一个循环的纬丝根数', state.repeat?.weftCount ?? 0, 4, 2048)}
            ${numberField('offsetCol', '横向起始格', state.repeat?.offsetCol ?? 0, 0, 2048)}
            ${numberField('offsetRow', '纵向起始格', state.repeat?.offsetRow ?? 0, 0, 2048)}
          </div>
          <div class="detected" id="gridInfo">${state.repeat ? `整幅估计格阵：${state.repeat.grid.totalCols} 经 × ${state.repeat.grid.totalRows} 纬；置信度 ${(state.repeat.confidence * 100).toFixed(0)}%` : '正在估计格阵…'}</div>
          <label class="color-count wide">纬线配色数
            <input id="colorCountRepeat" type="number" min="2" max="16" value="${state.colorCount}" />
          </label>
          <div class="hint">同一循环在横纵方向出现多次时，对应格点会取稳健中位数；污渍、破洞和局部褪色离群值不会进入最终色号。</div>
          ${state.groundTruth ? `<div class="truth-box">人工样片基准：${state.groundTruth.spec.warpCount} 经 × ${state.groundTruth.spec.weftCount} 纬 · ${state.groundTruth.spec.palette.length} 色</div>` : ''}
        </aside>
      </div>
    </section>`;

  const base = main.querySelector<HTMLCanvasElement>('#repeatBase')!;
  paintRgba(base, state.straight.image);
  const overlay = main.querySelector<HTMLCanvasElement>('#repeatOverlay')!;
  overlay.width = state.straight.width;
  overlay.height = state.straight.height;
  drawRepeatOverlay();

  main.querySelector<HTMLButtonElement>('#redetect')!.addEventListener('click', () => void detectRepeat());
  main.querySelector<HTMLInputElement>('#colorCountRepeat')!.addEventListener('change', (e) => {
    state.colorCount = Number((e.target as HTMLInputElement).value) || state.colorCount;
  });

  for (const key of ['warpCount', 'weftCount', 'offsetCol', 'offsetRow'] as const) {
    main.querySelector<HTMLInputElement>(`[data-key="${key}"]`)!.addEventListener('input', (e) => {
      if (!state.repeat) return;
      const value = Number((e.target as HTMLInputElement).value);
      state.repeat[key] = Number.isFinite(value) ? value : 0;
      drawRepeatOverlay();
    });
  }

  main.querySelector<HTMLButtonElement>('#buildPattern')!.addEventListener('click', async () => {
    if (!state.repeat) {
      toast('循环尚未找到');
      return;
    }
    setBusy(true, 'Worker 正在叠合多个循环、去除破洞并做 OKLab 归色…');
    try {
      state.pattern = await callWorker<PatternResult>({
        type: 'buildPattern',
        image: state.straight!.image,
        repeat: state.repeat,
        colorCount: state.colorCount,
      });
      toast(`已生成 ${state.pattern.width}×${state.pattern.height} 意匠格`);
      go('edit');
    } catch (error) {
      toast(`归色失败：${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  });
}

function numberField(key: string, label: string, value: number, min: number, max: number): string {
  return `<label>${label}<input data-key="${key}" type="number" min="${min}" max="${max}" value="${value}" /></label>`;
}

async function detectRepeat(): Promise<void> {
  if (!state.straight) return;
  setBusy(true, 'Worker 正在估计经纬间距和纹样循环…');
  try {
    state.repeat = await callWorker<RepeatInfo>({ type: 'detectRepeat', image: state.straight.image });
    if (state.page === 'repeat') renderRepeat();
    toast(`找到循环：${state.repeat.warpCount} 经 × ${state.repeat.weftCount} 纬`);
  } catch (error) {
    toast(`循环检测失败：${(error as Error).message}`);
  } finally {
    setBusy(false);
  }
}

function drawRepeatOverlay(): void {
  const overlay = document.querySelector<HTMLCanvasElement>('#repeatOverlay');
  if (!overlay || !state.repeat) return;
  const ctx = overlay.getContext('2d')!;
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const r = state.repeat;
  const g = r.grid;

  // 细格线仅在间距足够时绘制。
  if (g.pitchX >= 5 && g.pitchY >= 5) {
    ctx.strokeStyle = 'rgba(255,244,200,.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c <= g.totalCols; c++) {
      const x = c * g.pitchX;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, overlay.height);
    }
    for (let row = 0; row <= g.totalRows; row++) {
      const y = row * g.pitchY;
      ctx.moveTo(0, y);
      ctx.lineTo(overlay.width, y);
    }
    ctx.stroke();
  }

  const x = r.offsetCol * g.pitchX;
  const y = r.offsetRow * g.pitchY;
  const w = r.warpCount * g.pitchX;
  const h = r.weftCount * g.pitchY;
  ctx.fillStyle = 'rgba(226,64,48,.08)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#ffd34d';
  ctx.lineWidth = Math.max(2, overlay.width / 500);
  ctx.strokeRect(x, y, w, h);
  ctx.strokeStyle = '#c62828';
  ctx.setLineDash([overlay.width / 70, overlay.width / 110]);
  ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
  ctx.setLineDash([]);
}

/* --------------------------------- 编辑页 ---------------------------------- */

let editor: PatternEditor | null = null;

function renderEdit(): void {
  if (!state.pattern) {
    main.innerHTML = emptyState('还没有意匠图', '请先在循环单元页执行归色。');
    return;
  }

  main.innerHTML = `
    <section class="page edit-page">
      <div class="page-title">
        <div><h2>意匠图修改</h2><p>每格代表一个经纬交织点。可直接改格、取色、全局替换、撤销重做，并导出带格子的 PNG、JSON 和纬线用量。</p></div>
        <div class="actions">
          <button id="backRepeat">← 循环单元</button>
          <button id="exportCsv">用量 CSV</button>
          <button id="exportJson">JSON</button>
          <button class="primary" id="exportPng">导出带格 PNG</button>
        </div>
      </div>
      <div class="edit-layout">
        <div class="card editor-card">
          <div class="editor-toolbar">
            <button data-tool="pencil" class="tool active">画笔 B</button>
            <button data-tool="eyedropper" class="tool">取色 I</button>
            <button data-tool="replace" class="tool">同色替换</button>
            <span class="divider"></span>
            <button id="undoBtn">撤销</button>
            <button id="redoBtn">重做</button>
            <span class="divider"></span>
            <button id="zoomOut">−</button>
            <button id="zoomIn">＋</button>
            <button id="fitBtn">适应</button>
            <label class="check"><input id="gridToggle" type="checkbox" checked /> 格子线</label>
            <label class="check"><input id="confidenceToggle" type="checkbox" /> 低可信提示</label>
          </div>
          <div id="editorHost" class="editor-host"></div>
          <div class="hint">快捷键：B 画笔、I 取色、Ctrl/⌘+Z 撤销、Ctrl/⌘+Y 重做；右键或 Alt+点击可临时取色。</div>
        </div>
        <aside class="card usage-card">
          <h3>纬线配色与用量</h3>
          <div id="palette" class="palette"></div>
          <label class="color-count wide">每格平均纬长（毫米）
            <input id="weftMm" type="number" min="0.01" step="0.01" value="${state.weftMmPerCell}" />
          </label>
          <table class="usage-table">
            <thead><tr><th>色号</th><th>颜色</th><th>格数</th><th>占比</th><th>纬长(m)</th></tr></thead>
            <tbody id="usageBody"></tbody>
          </table>
          <div class="hint">纬长为按格距折算的估算值；若工艺单按“梭数/把数”统计，可直接使用格数和出现行数复核。</div>
        </aside>
      </div>
    </section>`;

  const host = main.querySelector<HTMLElement>('#editorHost')!;
  editor = new PatternEditor(host, state.pattern, (change) => {
    state.pattern = { ...state.pattern!, indices: change.indices, usage: change.usage };
    renderUsage();
  });

  main.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editor!.tool = btn.dataset.tool as PatternEditor['tool'];
      main.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
  main.querySelector('#undoBtn')!.addEventListener('click', () => editor?.undo());
  main.querySelector('#redoBtn')!.addEventListener('click', () => editor?.redo());
  main.querySelector('#zoomIn')!.addEventListener('click', () => editor?.zoomBy(1.2));
  main.querySelector('#zoomOut')!.addEventListener('click', () => editor?.zoomBy(1 / 1.2));
  main.querySelector('#fitBtn')!.addEventListener('click', () => editor?.fit());
  main.querySelector<HTMLInputElement>('#gridToggle')!.addEventListener('change', (e) => {
    editor?.setGridVisible((e.target as HTMLInputElement).checked);
  });
  main.querySelector<HTMLInputElement>('#confidenceToggle')!.addEventListener('change', (e) => {
    editor?.setConfidenceVisible((e.target as HTMLInputElement).checked);
  });
  host.addEventListener('editor-color-picked', ((e: CustomEvent<number>) => {
    selectPalette(e.detail);
  }) as EventListener);

  main.querySelector<HTMLInputElement>('#weftMm')!.addEventListener('change', (e) => {
    state.weftMmPerCell = Number((e.target as HTMLInputElement).value) || 0.2;
    renderUsage();
  });

  main.querySelector('#backRepeat')!.addEventListener('click', () => go('repeat'));
  main.querySelector('#exportPng')!.addEventListener('click', () => {
    if (!editor) return;
    editor.exportPng(30).toBlob((blob) => blob && downloadBlob(blob, 'yijiang-grid.png'), 'image/png');
  });
  main.querySelector('#exportJson')!.addEventListener('click', () => {
    if (!state.pattern || !editor) return;
    const data = {
      width: state.pattern.width,
      height: state.pattern.height,
      indices: Array.from(editor.getIndices()),
      palette: state.pattern.palette.map((p, i) => ({ index: i, ...p, hex: rgbToHex(p) })),
      usage: editor.getUsage(),
      repeat: state.repeat,
      source: state.fileName,
      exportedAt: new Date().toISOString(),
    };
    downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'yijiang-pattern.json');
  });
  main.querySelector('#exportCsv')!.addEventListener('click', () => exportUsageCsv());

  renderPalette();
  renderUsage();
  window.requestAnimationFrame(() => editor?.resize());
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  const hx = (v: number): string => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${hx(c.r)}${hx(c.g)}${hx(c.b)}`;
}

function renderPalette(): void {
  const paletteEl = document.querySelector<HTMLElement>('#palette');
  if (!paletteEl || !state.pattern || !editor) return;
  paletteEl.innerHTML = state.pattern.palette
    .map(
      (c, i) => `
      <button class="swatch ${i === editor!.selectedColor ? 'active' : ''}" data-color="${i}" title="${c.name} ${rgbToHex(c)}">
        <span class="chip" style="background:${rgbToHex(c)}"></span>
        <span><b>${i + 1}</b> ${c.name}<em>${rgbToHex(c)}</em></span>
      </button>`,
    )
    .join('');
  paletteEl.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((btn) => {
    btn.addEventListener('click', () => selectPalette(Number(btn.dataset.color)));
  });
}

function selectPalette(index: number): void {
  if (!editor) return;
  editor.selectedColor = index;
  editor.tool = 'pencil';
  document.querySelectorAll('.swatch').forEach((el) => el.classList.toggle('active', Number((el as HTMLElement).dataset.color) === index));
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', (b as HTMLElement).dataset.tool === 'pencil'));
}

function renderUsage(): void {
  const body = document.querySelector<HTMLTableSectionElement>('#usageBody');
  if (!body || !state.pattern || !editor) return;
  const usage = editor.getUsage();
  const total = usage.reduce((a, b) => a + b, 0);
  const rowPresence = countRowsPerColor(editor.getIndices(), state.pattern.width, state.pattern.height, usage.length);
  body.innerHTML = state.pattern.palette
    .map((c, i) => {
      const cells = usage[i] ?? 0;
      const percent = total ? ((cells / total) * 100).toFixed(1) : '0';
      const meters = ((cells * state.weftMmPerCell) / 1000).toFixed(3);
      return `<tr>
        <td>${i + 1}</td>
        <td><span class="table-chip" style="background:${rgbToHex(c)}"></span>${c.name}</td>
        <td>${cells}</td>
        <td>${percent}% · ${rowPresence[i]} 行</td>
        <td>${meters}</td>
      </tr>`;
    })
    .join('');
}

function countRowsPerColor(indices: Uint8Array, width: number, height: number, colorCount: number): number[] {
  const rows = new Array(colorCount).fill(0);
  for (let y = 0; y < height; y++) {
    const seen = new Set<number>();
    for (let x = 0; x < width; x++) seen.add(indices[y * width + x]);
    seen.forEach((i) => rows[i]++);
  }
  return rows;
}

function exportUsageCsv(): void {
  if (!state.pattern || !editor) return;
  const usage = editor.getUsage();
  const indices = editor.getIndices();
  const rows: string[] = ['色号,色名,HEX,格数,占比百分比,估算纬长米'];
  const total = usage.reduce((a, b) => a + b, 0);
  state.pattern.palette.forEach((c, i) => {
    rows.push([i + 1, c.name, rgbToHex(c), usage[i], ((usage[i] / total) * 100).toFixed(2), ((usage[i] * state.weftMmPerCell) / 1000).toFixed(4)].join(','));
  });
  rows.push('', '意匠格（色号从 1 开始）');
  for (let y = 0; y < state.pattern.height; y++) {
    const line: string[] = [];
    for (let x = 0; x < state.pattern.width; x++) line.push(String(indices[y * state.pattern!.width + x] + 1));
    rows.push(line.join(','));
  }
  downloadBlob(new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' }), 'weft-usage.csv');
}

function emptyState(title: string, message: string): string {
  return `<section class="page empty-page"><div class="card empty-card"><h2>${title}</h2><p>${message}</p><button class="primary" onclick="document.querySelector('[data-page=import]').click()">回照片导入页</button></div></section>`;
}

window.addEventListener('resize', () => editor?.resize());
render();
