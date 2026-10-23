// Lightweight signature pad: pointer events (finger, pen, mouse), smooth strokes, trimmed PNG export.
export class SignaturePad {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.onChange = onChange || (() => {});
    this.ink = '#14233c';
    canvas.addEventListener('pointerdown', (e) => this.start(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => canvas.addEventListener(t, (e) => this.end(e)));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.scale = dpr;
    this.cssW = r.width;
    this.cssH = r.height;
    this.redraw();
  }

  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, p: e.pressure || 0.5 };
  }

  start(e) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.current = [this.point(e)];
    this.strokes.push(this.current);
    this.redraw();
  }

  move(e) {
    if (!this.current) return;
    e.preventDefault();
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const pe of pts) this.current.push(this.point(pe));
    this.redraw();
  }

  end() {
    if (!this.current) return;
    this.current = null;
    this.onChange(this.hasInk());
  }

  hasInk() {
    // Require some actual drawing, not a single tap.
    let len = 0;
    for (const s of this.strokes) for (let i = 1; i < s.length; i++) len += Math.hypot((s[i].x - s[i - 1].x) * (this.cssW || 1), (s[i].y - s[i - 1].y) * (this.cssH || 1));
    return len > 40;
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.redraw();
    this.onChange(false);
  }

  drawTo(ctx, w, h, lineWidth, offX = 0, offY = 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = this.ink;
    ctx.fillStyle = this.ink;
    ctx.lineWidth = lineWidth;
    for (const s of this.strokes) {
      const P = s.map((p) => ({ x: p.x * w - offX, y: p.y * h - offY }));
      if (P.length === 1) { ctx.beginPath(); ctx.arc(P[0].x, P[0].y, lineWidth / 2, 0, Math.PI * 2); ctx.fill(); continue; }
      ctx.beginPath();
      ctx.moveTo(P[0].x, P[0].y);
      for (let i = 1; i < P.length - 1; i++) {
        const mx = (P[i].x + P[i + 1].x) / 2;
        const my = (P[i].y + P[i + 1].y) / 2;
        ctx.quadraticCurveTo(P[i].x, P[i].y, mx, my);
      }
      ctx.lineTo(P[P.length - 1].x, P[P.length - 1].y);
      ctx.stroke();
    }
  }

  redraw() {
    const { ctx, canvas } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.drawTo(ctx, canvas.width, canvas.height, 2.6 * (this.scale || 1));
  }

  /** Export a trimmed, transparent PNG (about 600px wide) as a data URL. */
  toPNG() {
    const W = 600;
    const H = Math.round(W * ((this.cssH || 150) / (this.cssW || 600)));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of this.strokes) for (const p of s) {
      minX = Math.min(minX, p.x * W); maxX = Math.max(maxX, p.x * W);
      minY = Math.min(minY, p.y * H); maxY = Math.max(maxY, p.y * H);
    }
    const pad = 8;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(W, maxX + pad); maxY = Math.min(H, maxY + pad);
    const out = document.createElement('canvas');
    out.width = Math.max(40, Math.round(maxX - minX));
    out.height = Math.max(20, Math.round(maxY - minY));
    this.drawTo(out.getContext('2d'), W, H, 3.2, minX, minY);
    return out.toDataURL('image/png');
  }
}
