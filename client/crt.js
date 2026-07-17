// The bridge monitor: a phosphor CRT that renders images as a grid of green
// dots (old dot-matrix look) and scrolls system comms / mission-log lines.
// NFT art, ship/crew portraits, and staff chatter all surface here.

const PHOSPHOR = '65, 255, 122';
const COLS = 60; // horizontal dot resolution

export function makeCrt(canvasId, commsId) {
  const canvas = document.getElementById(canvasId);
  const commsEl = document.getElementById(commsId);
  if (!canvas) return { showImage() {}, comm() {}, idle() {} };
  const ctx = canvas.getContext('2d');
  const off = document.createElement('canvas');
  const offCtx = off.getContext('2d', { willReadFrequently: true });

  let mode = 'idle';
  let img = null;
  let t = 0;
  let W = 0, H = 0;

  function fit() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const d = Math.min(devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(r.width * d)) {
      canvas.width = r.width * d; canvas.height = r.height * d;
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }
    W = r.width; H = r.height;
    return true;
  }

  function dot(cx, cy, rad, lum) {
    ctx.fillStyle = `rgba(${PHOSPHOR}, ${0.2 + 0.8 * lum})`;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawImage() {
    const cell = W / COLS;
    const rows = Math.max(1, Math.floor(H / cell));
    off.width = COLS; off.height = rows;
    offCtx.clearRect(0, 0, COLS, rows); // transparent stays transparent → skipped
    // contain-fit the image into the dot grid
    const ia = img.naturalWidth / img.naturalHeight || 1;
    const ga = COLS / rows;
    let dw, dh;
    if (ia > ga) { dw = COLS; dh = COLS / ia; } else { dh = rows; dw = rows * ia; }
    offCtx.drawImage(img, (COLS - dw) / 2, (rows - dh) / 2, dw, dh);
    const data = offCtx.getImageData(0, 0, COLS, rows).data;
    // pass 1: alpha-weighted luminance + its PEAK over opaque pixels
    const n = COLS * rows;
    const lums = new Float32Array(n);
    let hi = 0;
    for (let k = 0; k < n; k++) {
      const i = k * 4;
      const a = data[i + 3] / 255;
      const l = a * (0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2]) / 255;
      lums[k] = a < 0.15 ? -1 : l; // -1 marks transparent → skipped
      if (a >= 0.15 && l > hi) hi = l;
    }
    // scale so the brightest pixel maps near full — lifts a dark photo without
    // collapsing a uniformly-bright line drawing (peak gain, not range stretch)
    const gain = 0.95 / Math.max(hi, 0.12);
    const flick = 0.9 + 0.1 * Math.sin(t * 0.3);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < COLS; x++) {
        const raw = lums[y * COLS + x];
        if (raw < 0) continue;
        const l = Math.min(1, Math.pow(raw * gain, 0.75)); // gain + gentle gamma
        if (l < 0.05) continue;
        dot(x * cell + cell / 2, y * cell + cell / 2, (cell / 2) * 0.94 * Math.sqrt(l), l * flick);
      }
    }
  }

  function drawIdle() {
    // a slow phosphor sweep + faint dot grid, the "no signal" resting state
    const cell = W / COLS;
    const rows = Math.max(1, Math.floor(H / cell));
    const sweep = (t * 0.6) % (rows + 8) - 4;
    for (let y = 0; y < rows; y++) {
      const d = Math.abs(y - sweep);
      const lum = d < 3 ? (1 - d / 3) * 0.5 : 0.04;
      for (let x = 0; x < COLS; x++) {
        dot(x * cell + cell / 2, y * cell + cell / 2, cell * 0.16, lum);
      }
    }
  }

  function scanlines() {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    // vignette toward the bezel
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.2, W / 2, H / 2, H * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(3,8,5,0.85)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!fit()) return;
    ctx.fillStyle = '#030805';
    ctx.fillRect(0, 0, W, H);
    if (mode === 'image' && img && img.complete && img.naturalWidth) drawImage();
    else drawIdle();
    scanlines();
    t += 1;
  }
  requestAnimationFrame(frame);

  return {
    // Render an image URL as green dots. Falls back to idle on load error.
    showImage(url) {
      const im = new Image();
      im.onload = () => { img = im; mode = 'image'; };
      im.onerror = () => { mode = 'idle'; };
      im.src = url;
    },
    idle() { mode = 'idle'; img = null; },
    // Push a comms / mission-log line onto the terminal (keeps the last 6).
    comm(who, text) {
      if (!commsEl) return;
      const line = document.createElement('p');
      line.className = 'comm-line';
      const tag = document.createElement('span');
      tag.className = 'comm-who';
      tag.textContent = `${who}: `;
      line.appendChild(tag);
      line.appendChild(document.createTextNode(text));
      commsEl.appendChild(line);
      while (commsEl.children.length > 6) commsEl.removeChild(commsEl.firstChild);
      commsEl.scrollTop = commsEl.scrollHeight;
    },
  };
}
