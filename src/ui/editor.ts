import type { PatternResult } from '../types';
import { rgbToHex } from '../lib/color';
import { recalcUsage } from '../lib/repeat';

export type EditorTool = 'pencil' | 'eyedropper' | 'replace';

export interface EditorChange {
  indices: Uint8Array;
  usage: number[];
}

/**
 * 意匠图格子编辑器。Canvas 只绘制当前视口内可见格，支持缩放、平移、
 * 拖动画格、取色、全局替换和撤销/重做。
 */
export class PatternEditor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private indices: Uint8Array;
  private palette: PatternResult['palette'];
  private width: number;
  private height: number;
  private confidence: Float32Array;
  private usage: number[];

  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private cell = 18;
  private dpr = 1;
  private hover: { x: number; y: number } | null = null;
  private painting = false;
  private lastPainted: { x: number; y: number } | null = null;
  private activePointer: number | null = null;

  tool: EditorTool = 'pencil';
  selectedColor = 0;
  showGrid = true;
  showConfidence = false;
  private undoStack: Uint8Array[] = [];
  private redoStack: Uint8Array[] = [];

  constructor(
    private container: HTMLElement,
    pattern: PatternResult,
    private onChange?: (change: EditorChange) => void,
  ) {
    this.width = pattern.width;
    this.height = pattern.height;
    this.indices = pattern.indices.slice();
    this.palette = pattern.palette;
    this.confidence = pattern.confidence;
    this.usage = pattern.usage.slice();

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pattern-canvas';
    this.canvas.tabIndex = 0;
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
    this.ctx = ctx;

    this.bindEvents();
    this.resize();
    this.fit();
  }

  setPattern(pattern: PatternResult): void {
    this.width = pattern.width;
    this.height = pattern.height;
    this.indices = pattern.indices.slice();
    this.palette = pattern.palette;
    this.confidence = pattern.confidence;
    this.usage = pattern.usage.slice();
    this.undoStack = [];
    this.redoStack = [];
    this.fit();
  }

  setPaletteSelection(index: number): void {
    this.selectedColor = index;
  }

  setGridVisible(visible: boolean): void {
    this.showGrid = visible;
    this.render();
  }

  setConfidenceVisible(visible: boolean): void {
    this.showConfidence = visible;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  resize = (): void => {
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(320, rect.width);
    const h = Math.max(420, Math.min(720, window.innerHeight - 250));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.render();
  };

  fit(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width || this.container.clientWidth || 800;
    const h = rect.height || 520;
    this.cell = Math.max(4, Math.min(34, Math.floor(Math.min((w - 48) / this.width, (h - 48) / this.height))));
    this.zoom = 1;
    this.panX = (w - this.width * this.cell) / 2;
    this.panY = (h - this.height * this.cell) / 2;
    this.render();
  }

  zoomBy(factor: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const oldCell = this.cell * this.zoom;
    this.zoom = Math.max(0.35, Math.min(6, this.zoom * factor));
    const newCell = this.cell * this.zoom;
    this.panX = cx - ((cx - this.panX) / oldCell) * newCell;
    this.panY = cy - ((cy - this.panY) / oldCell) * newCell;
    this.render();
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.indices.slice());
    this.indices = previous;
    this.usage = recalcUsage(this.indices, this.palette.length);
    this.emitChange();
    this.render();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.indices.slice());
    this.indices = next;
    this.usage = recalcUsage(this.indices, this.palette.length);
    this.emitChange();
    this.render();
  }

  private pushUndo(): void {
    this.undoStack.push(this.indices.slice());
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  private emitChange(): void {
    this.onChange?.({ indices: this.indices, usage: this.usage });
  }

  private eventToCell(event: PointerEvent): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const cell = this.cell * this.zoom;
    const x = Math.floor((px - this.panX) / cell);
    const y = Math.floor((py - this.panY) / cell);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return { x, y };
  }

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.activePointer = e.pointerId;
      const cell = this.eventToCell(e);
      if (!cell) return;

      if (this.tool === 'eyedropper' || e.button === 2 || e.altKey) {
        this.selectedColor = this.indices[cell.y * this.width + cell.x];
        this.tool = 'pencil';
        this.container.dispatchEvent(new CustomEvent('editor-color-picked', { detail: this.selectedColor, bubbles: true }));
        return;
      }

      this.pushUndo();
      this.painting = true;
      this.lastPainted = null;
      this.paintLine(cell, cell);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      this.hover = this.eventToCell(e);
      if (this.painting && this.hover) {
        if (this.lastPainted) this.paintLine(this.lastPainted, this.hover);
        else this.paintCell(this.hover.x, this.hover.y);
        this.lastPainted = this.hover;
      }
      this.render();
    });

    const endPaint = (): void => {
      if (this.activePointer !== null && this.canvas.hasPointerCapture(this.activePointer)) {
        this.canvas.releasePointerCapture(this.activePointer);
      }
      this.activePointer = null;
      if (this.painting) {
        this.painting = false;
        this.lastPainted = null;
        this.usage = recalcUsage(this.indices, this.palette.length);
        this.emitChange();
      }
    };
    this.canvas.addEventListener('pointerup', endPaint);
    this.canvas.addEventListener('pointercancel', endPaint);
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.render();
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const oldCell = this.cell * this.zoom;
        this.zoom = Math.max(0.35, Math.min(6, this.zoom * factor));
        const newCell = this.cell * this.zoom;
        this.panX = mx - ((mx - this.panX) / oldCell) * newCell;
        this.panY = my - ((my - this.panY) / oldCell) * newCell;
        this.render();
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      if (!document.body.contains(this.canvas)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        this.redo();
      } else if (e.key === 'b') this.tool = 'pencil';
      else if (e.key === 'i') this.tool = 'eyedropper';
    });
  }

  private paintLine(a: { x: number; y: number }, b: { x: number; y: number }): void {
    let x0 = a.x;
    let y0 = a.y;
    const x1 = b.x;
    const y1 = b.y;
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    // Bresenham，快速拖动画线时不留空格。
    for (let guard = 0; guard < 4096; guard++) {
      this.applyToolAt(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x0 += sx;
      }
      if (e2 < dx) {
        err += dx;
        y0 += sy;
      }
    }
    this.render();
  }

  private paintCell(x: number, y: number): void {
    this.applyToolAt(x, y);
    this.render();
  }

  private applyToolAt(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = y * this.width + x;
    if (this.tool === 'replace') {
      const from = this.indices[i];
      if (from === this.selectedColor) return;
      for (let p = 0; p < this.indices.length; p++) if (this.indices[p] === from) this.indices[p] = this.selectedColor;
    } else {
      this.indices[i] = this.selectedColor;
    }
  }

  render(): void {
    const ctx = this.ctx;
    const cssW = this.canvas.clientWidth || this.container.clientWidth;
    const cssH = this.canvas.clientHeight || 520;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#f4efe4';
    ctx.fillRect(0, 0, cssW, cssH);

    const cell = this.cell * this.zoom;
    const gridW = this.width * cell;
    const gridH = this.height * cell;
    ctx.save();
    ctx.translate(this.panX, this.panY);

    // 棋盘底，提示尚未赋值/透明区域；本系统所有格均有色号。
    ctx.fillStyle = '#fffaf0';
    ctx.fillRect(0, 0, gridW, gridH);

    const x0 = Math.max(0, Math.floor(-this.panX / cell) - 1);
    const x1 = Math.min(this.width - 1, Math.ceil((cssW - this.panX) / cell) + 1);
    const y0 = Math.max(0, Math.floor(-this.panY / cell) - 1);
    const y1 = Math.min(this.height - 1, Math.ceil((cssH - this.panY) / cell) + 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const idx = this.indices[y * this.width + x];
        const c = this.palette[idx] ?? { r: 255, g: 0, b: 255 };
        ctx.fillStyle = `rgb(${c.r | 0},${c.g | 0},${c.b | 0})`;
        ctx.fillRect(x * cell, y * cell, Math.ceil(cell), Math.ceil(cell));
        if (this.showConfidence && this.confidence[y * this.width + x] < 0.72) {
          ctx.fillStyle = `rgba(255,255,255,${(0.72 - this.confidence[y * this.width + x]) * 0.9})`;
          ctx.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }

    if (this.showGrid && cell >= 4) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = cell >= 9 ? 'rgba(35,28,20,.34)' : 'rgba(35,28,20,.18)';
      ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) {
        ctx.moveTo(Math.round(x * cell) + 0.5, y0 * cell);
        ctx.lineTo(Math.round(x * cell) + 0.5, (y1 + 1) * cell);
      }
      for (let y = y0; y <= y1 + 1; y++) {
        ctx.moveTo(x0 * cell, Math.round(y * cell) + 0.5);
        ctx.lineTo((x1 + 1) * cell, Math.round(y * cell) + 0.5);
      }
      ctx.stroke();

      if (cell >= 14) {
        ctx.strokeStyle = 'rgba(120,35,28,.72)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = 0; x <= this.width; x += 8) {
          ctx.moveTo(x * cell, 0);
          ctx.lineTo(x * cell, gridH);
        }
        for (let y = 0; y <= this.height; y += 8) {
          ctx.moveTo(0, y * cell);
          ctx.lineTo(gridW, y * cell);
        }
        ctx.stroke();
      }
    }

    if (this.hover) {
      const { x, y } = this.hover;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffd84d';
      ctx.strokeRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    }

    ctx.strokeStyle = '#2b2118';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, gridW, gridH);
    ctx.restore();

    ctx.fillStyle = 'rgba(43,33,24,.72)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(`${this.width} 经 × ${this.height} 纬　缩放 ${(this.zoom * 100).toFixed(0)}%`, 12, cssH - 12);
  }

  exportPng(cellPixels = 28): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = this.width * cellPixels + 80;
    canvas.height = this.height * cellPixels + 60;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fffdf7';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(48, 28);

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const c = this.palette[this.indices[y * this.width + x]];
        ctx.fillStyle = rgbToHex(c);
        ctx.fillRect(x * cellPixels, y * cellPixels, cellPixels, cellPixels);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.width; x++) {
      ctx.moveTo(x * cellPixels + .5, 0);
      ctx.lineTo(x * cellPixels + .5, this.height * cellPixels);
    }
    for (let y = 0; y <= this.height; y++) {
      ctx.moveTo(0, y * cellPixels + .5);
      ctx.lineTo(this.width * cellPixels, y * cellPixels + .5);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(150,30,24,.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= this.width; x += 8) {
      ctx.moveTo(x * cellPixels, 0);
      ctx.lineTo(x * cellPixels, this.height * cellPixels);
    }
    for (let y = 0; y <= this.height; y += 8) {
      ctx.moveTo(0, y * cellPixels);
      ctx.lineTo(this.width * cellPixels, y * cellPixels);
    }
    ctx.stroke();

    ctx.fillStyle = '#3a2d20';
    ctx.font = '16px system-ui, sans-serif';
    for (let x = 0; x < this.width; x += 8) ctx.fillText(String(x + 1), x * cellPixels + 3, -8);
    for (let y = 0; y < this.height; y += 8) ctx.fillText(String(y + 1), -34, y * cellPixels + 18);
    return canvas;
  }

  getIndices(): Uint8Array {
    return this.indices.slice();
  }

  getUsage(): number[] {
    return this.usage.slice();
  }

  destroy(): void {
    this.canvas.remove();
  }
}
