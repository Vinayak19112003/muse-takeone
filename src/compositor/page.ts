/**
 * The compositor page. It runs inside headless Chromium and draws one frame at a time
 * from instructions sent by Node. Kept as a string so the package has no asset files.
 */
import { scrollplanJs } from "./scrollplan.inline.js";

export const compositorHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;overflow:hidden}
  body{width:100vw;height:100vh;background-size:cover;background-position:center}
  canvas{display:block;position:absolute;left:0;top:0}
</style></head><body><canvas id="c"></canvas><script>
${scrollplanJs}
(() => {
  const canvas = document.getElementById('c');
  let ctx, W, H, cfg;
  // Image cache for screenshots. Purely a performance cache: every __render call names
  // its images explicitly (file + previousFile), so correctness never depends on what a
  // previous call — or a previous parallel worker — loaded.
  const imageCache = new Map();
  const arrow = new Path2D('M0 0 L0 17 L4.5 13 L7.5 19.5 L10 18.5 L7 12.5 L12.5 12.5 Z');
  const ARROW_H = 19.5;

  window.__setup = (c) => {
    cfg = c; W = c.width; H = c.height;
    canvas.width = W; canvas.height = H;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx = canvas.getContext('2d', { alpha: true });
    document.body.style.background = c.background;
    if (c.backgroundImage) {
      document.body.style.backgroundImage = 'url(' + JSON.stringify(c.backgroundImage) + ')';
      document.body.style.backgroundSize = c.backgroundFit || 'cover';
    }
  };

  let bgLayer = null;
  window.__setBackground = (dataUrl) => new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => { bgLayer = i; resolve(); };
    i.onerror = () => reject(new Error('background load failed'));
    i.src = dataUrl;
  });
  window.__showCanvas = (on) => { canvas.style.display = on ? 'block' : 'none'; };

  window.__loadImage = (file) => new Promise((resolve, reject) => {
    const hit = imageCache.get(file);
    if (hit) {
      // Refresh recency for the small LRU cap below.
      imageCache.delete(file); imageCache.set(file, hit);
      return resolve(hit);
    }
    const i = new Image();
    i.onload = () => {
      imageCache.set(file, i);
      // Bound memory: a blend needs at most the current and previous screenshot.
      while (imageCache.size > 8) imageCache.delete(imageCache.keys().next().value);
      resolve(i);
    };
    i.onerror = () => reject(new Error('frame load failed: ' + file));
    i.src = '/frames/' + file;
  });

  function imageToImageData(img) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, c.width, c.height);
  }

  function fallbackScrollPlan(W, H, dx, dy, reason) {
    return {
      axis: 'v', mx: dx, my: dy, dx, dy,
      confidence: 0, useMeasured: false,
      cols: [{ x0: 0, x1: W, kind: 'document', d: dy, bands: [{ y0: 0, y1: H, kind: 'document', d: dy }] }],
      w: W, h: H,
      gutterX0: null, gutterW: 0,
      thumbA: null, thumbB: null,
      warnings: ['SCROLL_ANALYSIS_FAILED:' + reason],
    };
  }

  // Composite a scroll plan at eased progress sp (0..1) at natural size.
  // Used for the endpoint QA check and shared with __draw's plan path.
  function compositeScrollPlan(plan, sp, aImg, bImg) {
    const c = document.createElement('canvas');
    c.width = plan.w; c.height = plan.h;
    const x = c.getContext('2d');
    const ops = planScrollDraws(plan, sp);
    const S = aImg.naturalWidth / plan.w;
    for (const op of ops) {
      x.save();
      if (op.alpha < 1) x.globalAlpha = op.alpha;
      const srcImg = op.src === 'a' ? aImg : bImg;
      x.drawImage(srcImg, op.sx * S, op.sy * S, op.sw * S, op.sh * S, op.dx, op.dy, op.dw, op.dh);
      x.restore();
    }
    return c;
  }

  // Test helper: get draw ops for a scroll plan at sp (for debugging).
  window.__getScrollOpsForTest = (plan, sp) => {
    return planScrollDraws(plan, sp);
  };

  // Test helper: composite a scroll plan at sp and return base64 PNG.
  window.__compositeScrollPlanForTest = async (plan, sp, aFile, bFile) => {
    const aImg = await window.__loadImage(aFile);
    const bImg = await window.__loadImage(bFile);
    const c = compositeScrollPlan(plan, sp, aImg, bImg);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const u = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return "data:image/png;base64," + btoa(bin);
  };

  // Analyze a timed scroll: measure the true document displacement, partition
  // into document/fixed/sticky regions, detect the scrollbar. Returns a
  // serializable ScrollPlan. Never throws: on failure returns a fallback plan
  // that renders the scroll as pure document motion.
  window.__analyzeScroll = async (aFile, bFile, dx, dy) => {
    const aImg = await window.__loadImage(aFile);
    const bImg = await window.__loadImage(bFile);
    const W = aImg.naturalWidth, H = aImg.naturalHeight;
    let plan;
    try {
      const aData = imageToImageData(aImg);
      const bData = imageToImageData(bImg);
      plan = analyzeScroll(
        { width: W, height: H, data: aData.data },
        { width: bImg.naturalWidth, height: bImg.naturalHeight, data: bData.data },
        dx, dy,
      );
    } catch (e) {
      plan = fallbackScrollPlan(W, H, dx, dy, String((e && e.message) || e));
    }
    // Endpoint QA: the composite at sp=1 must match the post-scroll screenshot.
    try {
      const comp = compositeScrollPlan(plan, 1, aImg, bImg);
      const cData = comp.getContext('2d').getImageData(0, 0, plan.w, plan.h).data;
      const bPx = imageToImageData(bImg).data;
      let diff = 0;
      const n = plan.w * plan.h;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        diff += Math.abs(cData[o] - bPx[o]) + Math.abs(cData[o + 1] - bPx[o + 1]) + Math.abs(cData[o + 2] - bPx[o + 2]);
      }
      if (diff / (n * 3) > 7) plan.warnings.push('SCROLL_ENDPOINT_DISCONTINUITY');
    } catch (e) {
      plan.warnings.push('SCROLL_ENDPOINT_CHECK_FAILED');
    }
    return plan;
  };

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }

  // Static shadow layer, drawn once.
  let shadowLayer = null;
  function getShadowLayer() {
    if (shadowLayer || !cfg.shadow) return shadowLayer;
    const C = cfg.content;
    shadowLayer = document.createElement('canvas'); shadowLayer.width = W; shadowLayer.height = H;
    const sc = shadowLayer.getContext('2d');
    sc.shadowBlur = cfg.shadow.blur; sc.shadowOffsetY = cfg.shadow.offsetY; sc.shadowColor = cfg.shadow.color;
    sc.fillStyle = '#000';
    const r = cfg.borderRadius;
    sc.beginPath();
    sc.moveTo(C.x + r, C.y); sc.lineTo(C.x + C.w - r, C.y); sc.quadraticCurveTo(C.x + C.w, C.y, C.x + C.w, C.y + r);
    sc.lineTo(C.x + C.w, C.y + C.h - r); sc.quadraticCurveTo(C.x + C.w, C.y + C.h, C.x + C.w - r, C.y + C.h);
    sc.lineTo(C.x + r, C.y + C.h); sc.quadraticCurveTo(C.x, C.y + C.h, C.x, C.y + C.h - r);
    sc.lineTo(C.x, C.y + r); sc.quadraticCurveTo(C.x, C.y, C.x + r, C.y); sc.closePath(); sc.fill();
    return shadowLayer;
  }

  // Full frame: load sources, draw, and return the encoded image as base64.
  // Stateless across calls: the outgoing screenshot for a crossfade arrives as
  // f.previousFile on the instruction itself, so a worker that starts mid-transition
  // renders the identical blend as one that rendered the earlier frames.
  window.__render = async (f, lossless) => {
    const img = await window.__loadImage(f.file);
    let prevImg = null;
    if (f.previousFile && f.mix != null && f.mix < 1) prevImg = await window.__loadImage(f.previousFile);
    window.__draw(f, img, prevImg);
    const blob = await new Promise((r) => canvas.toBlob(r, lossless ? 'image/png' : 'image/jpeg', 0.95));
    const u = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(bin);
  };

  // f: { cam:{px,py,scale}, cursor:{x,y,pressed,visible}, ripples:[{x,y,p}], uiScale, mix, slide, isScroll }
  window.__draw = (f, img, prevImg) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const C = cfg.content;
    const s = f.cam.scale;
    // Whole composition zooms about the camera point: background, padding, shadow and content.
    ctx.setTransform(s, 0, 0, s, W / 2 - f.cam.px * s, H / 2 - f.cam.py * s);
    if (bgLayer) ctx.drawImage(bgLayer, 0, 0, W, H);
    const sl = getShadowLayer();
    if (sl) ctx.drawImage(sl, 0, 0);
    ctx.save();
    roundRect(C.x, C.y, C.w, C.h, cfg.borderRadius); ctx.clip();
    if (img) {
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      // Only the visible part of the source is drawn, to keep the raster cost bounded.
      const visX0 = f.cam.px - W / (2 * s), visY0 = f.cam.py - H / (2 * s);
      const x0 = Math.max(C.x, visX0), y0 = Math.max(C.y, visY0);
      const x1 = Math.min(C.x + C.w, visX0 + W / s), y1 = Math.min(C.y + C.h, visY0 + H / s);
      if (x1 > x0 && y1 > y0) {
        const fx = img.naturalWidth / C.w, fy = img.naturalHeight / C.h;
        if (f.isScroll && prevImg && f.mix != null && f.mix < 1) {
          if (f.scrollPlan) {
            // Document/sticky/fixed layer compositing from a precomputed plan.
            // Only the document layer moves by the full displacement; sticky
            // regions move by their own measured offset; fixed regions (and
            // the scrollbar gutter) stay in viewport coordinates. The newly
            // revealed strip comes from the post-scroll screenshot alone, so
            // overlapping text is always drawn from a single source.
            const p = f.mix;
            const sp = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
            const plan = f.scrollPlan;
            const ops = planScrollDraws(plan, sp);
            const S = prevImg.naturalWidth / plan.w;
            const kw = C.w / plan.w, kh = C.h / plan.h;
            for (const op of ops) {
              ctx.save();
              if (op.alpha < 1) ctx.globalAlpha = op.alpha;
              const srcImg = op.src === 'a' ? prevImg : img;
              ctx.translate(C.x + op.dx * kw, C.y + op.dy * kh);
              ctx.drawImage(
                srcImg,
                op.sx * S, op.sy * S, op.sw * S, op.sh * S,
                0, 0, op.dw * kw, op.dh * kh,
              );
              ctx.restore();
            }
          } else {
          // True scroll transition: BOTH screenshots translate with cubic
          // ease-in-out so overlapping page content stays aligned throughout —
          // one continuous page moving, not a dissolve. No crossfade is applied.
          // The old screenshot moves away by slide * sp; the new one enters from
          // -slide * (1 - sp), so at every instant the shared content lines up.
          // Limitation: the whole frame translates, so sticky/fixed elements
          // (e.g. a pinned header) slide with the page instead of staying put.
          // See docs/limitations.md.
          const p = f.mix;
          const sp = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
          const slx = f.slide?.x ?? 0, sly = f.slide?.y ?? 0;
          // New screenshot first (base layer), translating into place.
          ctx.save();
          ctx.translate(-slx * (1 - sp), -sly * (1 - sp));
          ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, C.x, C.y, C.w, C.h);
          ctx.restore();
          // Old screenshot on top, translating away.
          ctx.save();
          ctx.translate(slx * sp, sly * sp);
          ctx.drawImage(prevImg, 0, 0, prevImg.naturalWidth, prevImg.naturalHeight, C.x, C.y, C.w, C.h);
          ctx.restore();
          }
        } else {
          ctx.drawImage(img, (x0 - C.x) * fx, (y0 - C.y) * fy, (x1 - x0) * fx, (y1 - y0) * fy, x0, y0, x1 - x0, y1 - y0);
          // Crossfade from the previous frame right after a cut: the old image
          // fades out on top of the new one over MIX_MS, under the same camera.
          // With f.slide (legacy slide nudge), the old image also slides in the
          // scroll direction so the movement reads on screen.
          if (prevImg && f.mix != null && f.mix < 1) {
            ctx.globalAlpha = 1 - f.mix;
            const sp = f.mix * f.mix * (3 - 2 * f.mix); // smoothstep the slide
            const sx = (f.slide?.x ?? 0) * sp, sy = (f.slide?.y ?? 0) * sp;
            const ofx = prevImg.naturalWidth / C.w, ofy = prevImg.naturalHeight / C.h;
            // Widen the culled region by the slide so the moving edge isn't clipped.
            const pad = Math.max(Math.abs(sx), Math.abs(sy));
            const qx0 = Math.max(C.x, x0 - pad), qy0 = Math.max(C.y, y0 - pad);
            const qx1 = Math.min(C.x + C.w, x1 + pad), qy1 = Math.min(C.y + C.h, y1 + pad);
            ctx.save();
            ctx.translate(sx, sy);
            ctx.drawImage(prevImg, (qx0 - C.x) * ofx, (qy0 - C.y) * ofy, (qx1 - qx0) * ofx, (qy1 - qy0) * ofy, qx0, qy0, qx1 - qx0, qy1 - qy0);
            ctx.restore();
            ctx.globalAlpha = 1;
          }
        }
      }
    }
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Ripples
    for (const r of f.ripples || []) {
      const p = r.p; // 0..1 progress
      const radius = (10 + 34 * p) * f.uiScale;
      ctx.beginPath(); ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.85 * (1 - p)) + ')';
      ctx.lineWidth = 3 * f.uiScale * (1 - p * 0.6); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.25 * (1 - p)) + ')'; ctx.fill();
    }
    ctx.restore();
    // Cursor (not clipped, so it can sit on the frame edge)
    if (f.cursor && f.cursor.visible) {
      const s = (cfg.cursor.size / ARROW_H) * f.uiScale * (f.cursor.pressed && cfg.cursor.clickScale ? 0.86 : 1);
      ctx.save();
      ctx.translate(f.cursor.x, f.cursor.y);
      if (cfg.cursor.style === 'dot') {
        ctx.shadowBlur = 6; ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.beginPath(); ctx.arc(0, 0, cfg.cursor.size * 0.35 * f.uiScale, 0, Math.PI * 2);
        ctx.fillStyle = cfg.cursor.color; ctx.globalAlpha = 0.9; ctx.fill();
      } else {
        ctx.scale(s, s);
        ctx.shadowBlur = 4 / s; ctx.shadowOffsetY = 2 / s; ctx.shadowColor = 'rgba(0,0,0,0.55)';
        ctx.fillStyle = '#000'; ctx.fill(arrow);
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.lineWidth = 1.4; ctx.strokeStyle = '#fff'; ctx.lineJoin = 'round'; ctx.stroke(arrow);
      }
      ctx.restore();
    }
    if (f.hud) drawHud(f.hud);
    if (f.caption) drawCaption(f.caption);
    return true;
  };

  // Narrative caption pill, fixed on screen (not affected by the camera).
  // Sits near the bottom edge, below the key HUD when both are visible.
  function drawCaption(text) {
    const fs = 34, padX = 30, padY = 15;
    ctx.save();
    ctx.font = '600 ' + fs + 'px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const pillW = ctx.measureText(text).width + padX * 2, pillH = fs + padY * 2;
    const x = (W - pillW) / 2, y = H - 44 - pillH;
    ctx.shadowBlur = 24; ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowOffsetY = 4;
    ctx.fillStyle = 'rgba(18,18,22,0.85)';
    roundRect(x, y, pillW, pillH, pillH / 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x + padX, y + pillH / 2 + 2);
    ctx.restore();
  }

  // Screen Studio style key pill, fixed on screen (not affected by the camera).
  function drawHud(h) {
    const fs = cfg.keys.fontSize, pad = fs * 0.8, capPad = fs * 0.65, gapKeys = fs * 0.3, gapGroups = fs * 0.8, r = fs * 0.4;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, h.alpha));
    ctx.font = '600 ' + fs + 'px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    const capH = fs * 1.7;
    // Measure
    const groups = h.groups.map((g) => g.map((label) => ({ label, w: ctx.measureText(label).width + capPad * 2 })));
    let total = 0;
    groups.forEach((g, gi) => { g.forEach((k, ki) => { total += k.w + (ki ? gapKeys : 0); }); if (gi) total += gapGroups; });
    const pillW = total + pad * 2, pillH = capH + pad * 2;
    const x = (W - pillW) / 2;
    const y = cfg.keys.position === 'top' ? H * cfg.keys.offset : H - H * cfg.keys.offset - pillH;
    ctx.shadowBlur = fs * 0.8; ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowOffsetY = fs * 0.15;
    ctx.fillStyle = 'rgba(18,18,22,0.82)';
    roundRect(x, y, pillW, pillH, pillH / 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    let cx = x + pad;
    for (const g of groups) {
      for (let ki = 0; ki < g.length; ki++) {
        const k = g[ki];
        if (h.kind === 'shortcut') {
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          roundRect(cx, y + pad, k.w, capH, r); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(k.label, cx + capPad, y + pad + capH / 2 + fs * 0.05);
        cx += k.w + gapKeys;
      }
      cx += gapGroups - gapKeys;
    }
    ctx.restore();
  }
})();
</script></body></html>`;
