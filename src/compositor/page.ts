/**
 * The compositor page. It runs inside headless Chromium and draws one frame at a time
 * from instructions sent by Node. Kept as a string so the package has no asset files.
 */
export const compositorHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;overflow:hidden}
  body{width:100vw;height:100vh;background-size:cover;background-position:center}
  canvas{display:block;position:absolute;left:0;top:0}
</style></head><body><canvas id="c"></canvas><script>
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

  // f: { cam:{px,py,scale}, cursor:{x,y,pressed,visible}, ripples:[{x,y,p}], uiScale, mix }
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
        ctx.drawImage(img, (x0 - C.x) * fx, (y0 - C.y) * fy, (x1 - x0) * fx, (y1 - y0) * fy, x0, y0, x1 - x0, y1 - y0);
        // Crossfade from the previous frame right after a cut: the old image
        // fades out on top of the new one over MIX_MS, under the same camera.
        // With f.slide (scroll transitions), the old image also slides in the
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
