// SKY HARBOUR bridge console — the rail is the mission builder. Each nav button
// carries data-frame / data-slug / data-hint, so order and labels can change
// freely; nothing here is index-coupled to the frame DOM order anymore.

// Channels that drive the big display come from two places now: the rail
// (the SHIP/MISSION/CREW build steps) and the console's screen buttons
// (BRIDGE/VOID CHART/STORY/TOKENS/SETTLEMENT). Both carry data-frame/-slug/
// -hint, so they merge into one ordered channel list the arrows cycle.
const channels = [
    ...document.querySelectorAll('.bottom-div .item_button[data-frame]'),
    ...document.querySelectorAll('.button-grid .button-cell[data-frame]'),
];
const slugs = channels.map((b) => b.dataset.slug);
let currentIndex = 0;

const labelOf = (el) => (el.querySelector('p, .btn-label')?.textContent ?? '');

function activate(index) {
    currentIndex = Math.max(0, Math.min(channels.length - 1, index));
    const btn = channels[currentIndex];
    const targetId = btn.dataset.frame;

    document.querySelectorAll('.frame').forEach((frame) => {
        const on = frame.id === targetId;
        frame.classList.toggle('active', on);
        if (on) {
            frame.classList.add('frame-glitch');
            setTimeout(() => frame.classList.remove('frame-glitch'), 1000);
        } else {
            frame.classList.remove('frame-glitch');
        }
    });

    const label = labelOf(btn);
    document.getElementById('frame-name').innerHTML = label.split('')
        .map((char, i) => `<span style="animation-delay:${i * 0.1}s">${char === ' ' ? '&nbsp;' : char}</span>`)
        .join('');
    document.getElementById('card-details').textContent = btn.dataset.hint || '';
    channels.forEach((b, i) => b.classList.toggle('active', i === currentIndex));

    if (btn.dataset.slug && location.hash.replace('#', '') !== btn.dataset.slug) location.hash = btn.dataset.slug;
}

channels.forEach((button, index) => button.addEventListener('click', () => activate(index)));
document.getElementById('prev-button').addEventListener('click', () => activate(currentIndex - 1));
document.getElementById('next-button').addEventListener('click', () => activate(currentIndex + 1));

// Deep-link by slug (#ship, #mission, …); default to step 1, SHIP.
const fromHash = slugs.indexOf(location.hash.replace('#', ''));
activate(fromHash >= 0 ? fromHash : 0);

// ================= THE VOID SCREEN =================
// Wireframe sky-islands over the void; a cargo ship runs its
// delivery line to the half-built settlement. Phosphor on black.
(function () {
    const cv = document.getElementById('void-screen');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, t = 0;

    function resize() {
        const r = cv.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false; // frame hidden
        if (Math.abs(r.width - W) < 1 && Math.abs(r.height - H) < 1) return true;
        const d = Math.min(devicePixelRatio || 1, 2);
        W = r.width; H = r.height;
        cv.width = W * d; cv.height = H * d;
        ctx.setTransform(d, 0, 0, d, 0, 0);
        return true;
    }
    addEventListener('resize', resize);

    let seed = 7;
    function rnd() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

    const stars = [];
    for (let i = 0; i < 70; i++) stars.push({ x: rnd(), y: rnd() * 0.5, a: 0.15 + rnd() * 0.5 });

    function mkIsland(cx, cy, cz, r, drift) {
        const n = 7 + Math.floor(rnd() * 3), ring = [];
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2;
            ring.push([Math.cos(a) * r * (0.75 + rnd() * 0.5), Math.sin(a) * r * (0.7 + rnd() * 0.45)]);
        }
        return { cx, cy, cz, ring, keel: r * (1.1 + rnd() * 0.9), drift, ph: rnd() * Math.PI * 2 };
    }
    const islands = [
        mkIsland(-300, 25, 520, 80, 0.25),
        mkIsland(-110, -20, 900, 110, 0.18),
        mkIsland(150, 40, 650, 70, 0.3),
        mkIsland(380, -10, 1100, 130, 0.15),
        mkIsland(30, 75, 380, 46, 0.4),
    ];
    const FOV = 380;

    function proj(x, y, z) {
        const s = FOV / (FOV + z);
        return [W / 2 + x * s, H * 0.5 + y * s, s];
    }
    function stroke(alpha, w) {
        ctx.strokeStyle = 'rgba(65,255,122,' + alpha + ')';
        ctx.lineWidth = w || 1;
    }

    function drawIsland(o, time) {
        const bob = Math.sin(time * 0.0006 * o.drift * 4 + o.ph) * 7;
        const y = o.cy + bob;
        const pts = o.ring.map(p => proj(o.cx + p[0], y + p[1] * 0.28, o.cz));
        const depth = pts[0][2];
        stroke(0.22 + depth * 0.5, 1);
        ctx.beginPath();
        pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
        ctx.closePath(); ctx.stroke();
        const tip = proj(o.cx, y + o.keel, o.cz);
        ctx.beginPath();
        for (let i = 0; i < pts.length; i += 2) { ctx.moveTo(pts[i][0], pts[i][1]); ctx.lineTo(tip[0], tip[1]); }
        ctx.stroke();
    }

    function drawSettlement(time) {
        const cx = 250, cz = 240, baseY = 55 + Math.sin(time * 0.0004) * 4;
        const p = (x, y) => proj(cx + x, baseY + y, cz);
        stroke(0.8, 1.2);
        const plat = [p(-75, 0), p(75, 0), p(58, 12), p(-58, 12)];
        ctx.beginPath(); plat.forEach((q, i) => i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]));
        ctx.closePath(); ctx.stroke();
        ctx.beginPath();
        const a = p(-42, 0), b = p(-42, -38), c = p(8, -38), d = p(8, 0), e = p(-17, -58);
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.lineTo(e[0], e[1]); ctx.lineTo(c[0], c[1]); ctx.lineTo(d[0], d[1]);
        ctx.stroke();
        ctx.beginPath();
        const k1 = p(34, 0), k2 = p(34, -50), k3 = p(64, -43);
        ctx.moveTo(k1[0], k1[1]); ctx.lineTo(k2[0], k2[1]); ctx.lineTo(k3[0], k3[1]);
        ctx.stroke();
        return { x: cx, y: baseY - 18, z: cz };
    }

    function drawShip(time, target) {
        const T = 14000, k = reduced ? 0.62 : (time % T) / T;
        const sx = -380 + (target.x - -380) * k;
        const sz = 560 + (target.z - 560) * k;
        const sy = -35 + Math.sin(k * Math.PI) * -50 + Math.sin(time * 0.004) * 3;
        const p = (x, y, z) => proj(sx + x, sy + y, sz + z);
        stroke(0.95, 1.3);
        const nose = p(22, 0, 0), tl = p(-13, -8, -7), tr = p(-13, -8, 7), bl = p(-12, 7, 0);
        ctx.beginPath();
        ctx.moveTo(nose[0], nose[1]); ctx.lineTo(tl[0], tl[1]); ctx.lineTo(tr[0], tr[1]); ctx.closePath();
        ctx.moveTo(nose[0], nose[1]); ctx.lineTo(bl[0], bl[1]); ctx.lineTo(tl[0], tl[1]);
        ctx.moveTo(bl[0], bl[1]); ctx.lineTo(tr[0], tr[1]);
        ctx.stroke();
        const tp = proj(target.x, target.y, target.z);
        stroke(0.28, 1); ctx.setLineDash([3, 7]);
        ctx.beginPath(); ctx.moveTo(nose[0], nose[1]); ctx.lineTo(tp[0], tp[1]); ctx.stroke();
        ctx.setLineDash([]);
    }

    function frame() {
        if (!resize()) return; // hidden channel: skip drawing
        ctx.clearRect(0, 0, W, H);
        for (const s of stars) {
            ctx.fillStyle = 'rgba(65,255,122,' + s.a + ')';
            ctx.fillRect(s.x * W, s.y * H, 1.5, 1.5);
        }
        const sorted = islands.slice().sort((a, b) => b.cz - a.cz);
        for (const o of sorted) drawIsland(o, t);
        const target = drawSettlement(t);
        drawShip(t, target);
        t += 16;
    }

    if (reduced) {
        t = 8600;
        // draw once now and again whenever HOME becomes visible
        frame();
        bottomButtons.forEach(b => b.addEventListener('click', () => setTimeout(frame, 30)));
    } else {
        (function loop() { frame(); requestAnimationFrame(loop); })();
    }
})();
