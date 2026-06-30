/* Wipeout Gauntlet spectator board. Polls ./state.json (the referee's live game
 * state) and renders the candy-voxel obstacle gauntlet: two jelly-bean racers
 * bounce left->right across pastel platforms — past spinning hammers and swinging
 * pendulums — toward the CROWN, with progress bars, wipe counts, and live odds.
 * Read-only and offline — everything is drawn procedurally (no remote assets),
 * like the chess board's app.js. Dispatches on data.game so the same SPA shape
 * generalises. */
(function () {
  const W = 780, H = 560, GOAL = 100, STATIONS = 6;
  const cv = document.getElementById("c"), ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  const statusEl = document.getElementById("status");

  // course geometry (mirrors the POC): platforms run left->right, the CROWN
  // sits on the last station so the full width is always in play.
  const TRACK_X0 = 96, TRACK_X1 = W - 118, TRACK_Y = 320;
  const PASTELS = ["#ffd1e8", "#c9f0ff", "#fff3b0", "#d4ffd6", "#e6d1ff", "#ffe0c2"];
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const stationX = (s) => TRACK_X0 + (TRACK_X1 - TRACK_X0) * (s / STATIONS);
  const stationY = (s) => TRACK_Y + Math.sin(s * 0.95 + 0.6) * 24 - s * 5.2;
  const CROWN = { x: stationX(STATIONS), y: stationY(STATIONS) - 92 };

  // map progress 0..GOAL -> screen position interpolating between stations,
  // with a mild ease so even a modest lead fills the right half of the track.
  function progPos(prog) {
    const raw = clamp(prog / GOAL, 0, 1);
    const eased = Math.pow(raw, 0.82);
    const f = eased * STATIONS;
    const s0 = Math.min(STATIONS - 1, Math.floor(f)), s1 = Math.min(STATIONS, s0 + 1), tt = f - s0;
    return { x: lerp(stationX(s0), stationX(s1), tt), y: lerp(stationY(s0), stationY(s1), tt) };
  }

  // deterministic per-station rng (mulberry32), so platform sprinkles/obstacles
  // are stable across frames and seeds, matching the referee's layout intent.
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let data = null;            // latest state.json
  let shown = [0, 0];         // displayed progress (eased toward real)

  async function tick() {
    try {
      const r = await fetch("./state.json", { cache: "no-store" });
      data = await r.json();
      if (data.game !== "wipeout") {
        statusEl.innerHTML = `<span class="off">unsupported game: ${data.game || "?"}</span>`;
        data = null;
      } else {
        const p = data.racers;
        statusEl.textContent = data.winner
          ? `Final — ${data.winner} wins (${data.win_reason}).`
          : `Live · ${p[0].handle} ${p[0].progress}% (💥${p[0].wipes}) vs ${p[1].handle} ${p[1].progress}% (💥${p[1].wipes}) · leading ${data.leader || "—"}`;
      }
    } catch (e) {
      statusEl.innerHTML = `<span class="off">waiting for referee…</span>`;
    }
  }
  setInterval(tick, 1000); tick();

  // ---- scene pieces ----
  function candyVoid(t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#ff9ec7"); g.addColorStop(0.42, "#ffb3d1");
    g.addColorStop(0.66, "#ff86b8"); g.addColorStop(1, "#e85a9b");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    glow(W * 0.5, 92, 220, "rgba(255,250,220,0.45)");
    ctx.fillStyle = "#fff6e0"; ctx.beginPath(); ctx.arc(W * 0.5, 92, 38, 0, 7); ctx.fill();
    for (let i = 0; i < 30; i++) {
      const x = (i * 151 + t * 0.012 * (1 + (i % 3))) % W, y = (i * 83) % (H - 120);
      const tw = (Math.sin(t / 800 + i) + 1) / 2;
      ctx.fillStyle = PASTELS[i % PASTELS.length] + (i % 2 ? "55" : "33");
      ctx.beginPath(); ctx.arc(x, y, 2 + (i % 3) + tw * 1.5, 0, 7); ctx.fill();
    }
  }
  function clouds(t) {
    const spec = [[90, 130, 60], [330, 100, 46], [560, 120, 54], [690, 150, 64], [200, 200, 40]];
    for (const [bx, by, r] of spec) {
      const x = bx + Math.sin(t / 4000 + bx) * 14;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(x, by, r * 0.6, 0, 7); ctx.arc(x + r * 0.5, by + 6, r * 0.5, 0, 7);
      ctx.arc(x - r * 0.5, by + 8, r * 0.42, 0, 7); ctx.arc(x + r * 0.15, by - r * 0.25, r * 0.45, 0, 7);
      ctx.fill();
    }
  }
  function voidGoo(t) {
    const baseY = H - 64;
    ctx.fillStyle = "#d6347e"; ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) {
      const y = baseY + Math.sin(x * 0.03 + t / 500) * 7 + Math.cos(x * 0.07 + t / 700) * 4;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "rgba(255,200,230,0.6)"; ctx.lineWidth = 2; ctx.beginPath();
    for (let x = 0; x <= W; x += 24) {
      const y = baseY + Math.sin(x * 0.03 + t / 500) * 7 + Math.cos(x * 0.07 + t / 700) * 4;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function platforms(t, seed, twist) {
    for (let s = 0; s < STATIONS; s++) {
      const x = stationX(s), y = stationY(s), col = PASTELS[s % PASTELS.length];
      const r = rng(seed * 71 + s * 13);
      const crumble = r() < 0.4;
      const jitter = crumble ? Math.sin(t / 160 + s) * 1.2 : 0;
      shadow(x, stationY(s) + 92, 46, 12, 0.18);
      candyBlock(x - 39 + jitter, y, 78, 56, 18, col, crumble, s);
      label(x, y - 24, String(s + 1), 13, "rgba(90,40,80,0.55)", "center");
      if (s === twist) {
        const a = 0.3 + 0.3 * Math.sin(t / 220);
        ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = 2;
        rrect(x - 42, y - 3, 84, 6, 3); ctx.stroke();
      }
    }
  }
  function candyBlock(x, y, w, h, d, col, crumble, s) {
    ctx.fillStyle = shade(col, 1.12);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w + d, y - d); ctx.lineTo(x + d, y - d); ctx.closePath(); ctx.fill();
    ctx.fillStyle = shade(col, 0.74);
    ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w + d, y - d); ctx.lineTo(x + w + d, y - d + h); ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill();
    ctx.fillStyle = col; rrect(x, y, w, h, 8); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)"; rrect(x + 4, y + 4, w - 8, 8, 4); ctx.fill();
    const r = rng(s * 991 + 3);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = PASTELS[(s + i + 2) % PASTELS.length];
      ctx.fillRect(x + 8 + r() * (w - 16), y + 18 + r() * (h - 24), 4, 4);
    }
    if (crumble) {
      ctx.strokeStyle = "rgba(120,50,90,0.35)"; ctx.lineWidth = 1.4; ctx.beginPath();
      ctx.moveTo(x + w * 0.3, y); ctx.lineTo(x + w * 0.42, y + h * 0.5); ctx.lineTo(x + w * 0.34, y + h);
      ctx.moveTo(x + w * 0.65, y); ctx.lineTo(x + w * 0.58, y + h * 0.6); ctx.stroke();
    }
  }

  function obstacles(t, seed, twist) {
    for (let s = 1; s < STATIONS; s++) {
      const r = rng(seed * 71 + s * 13);
      const hammer = r() < 0.5, phase = r();
      const x = stationX(s);
      if (hammer) spinningHammer(x, stationY(s) - 78, phase, t, s === twist);
      else pendulum(x, stationY(s) - 110, phase, t, s === twist);
    }
  }
  function spinningHammer(x, y, phase, t, twist) {
    const ang = (t / 620) + phase * Math.PI * 2;
    ctx.fillStyle = "#b86fb0"; ctx.fillRect(x - 4, y, 8, 70);
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = "#9d4edd"; rrect(-6, -4, 54, 8, 4); ctx.fill();
    const hx = 50;
    ctx.fillStyle = twist ? "#ff5db1" : "#7b2ff7"; rrect(hx - 12, -16, 26, 32, 8); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)"; rrect(hx - 9, -13, 8, 26, 4); ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#5a189a"; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
    ctx.fillStyle = "#c77dff"; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
  }
  function pendulum(x, y, phase, t, twist) {
    const sw = Math.sin(t / 560 + phase * Math.PI * 2) * 0.9, len = 96;
    ctx.fillStyle = "#b86fb0"; ctx.fillRect(x - 36, y - 8, 72, 8);
    ctx.save(); ctx.translate(x, y); ctx.rotate(sw);
    ctx.strokeStyle = "rgba(120,60,110,0.8)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, len); ctx.stroke();
    glow(0, len, 26, twist ? "rgba(255,93,177,0.4)" : "rgba(168,85,247,0.35)");
    ctx.fillStyle = twist ? "#ff5db1" : "#9d4edd"; ctx.beginPath(); ctx.arc(0, len, 17, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.beginPath(); ctx.arc(-5, len - 5, 6, 0, 7); ctx.fill();
    ctx.restore();
  }

  function crownGoal(t, won) {
    const x = CROWN.x, y = CROWN.y;
    candyBlock(x - 40, stationY(STATIONS), 80, 56, 18, "#fff3b0", false, 99);
    glow(x, y + 30, 70, won ? "rgba(255,215,0,0.6)" : "rgba(255,225,120,0.35)");
    const bob = Math.sin(t / 500) * 5;
    ctx.save(); ctx.translate(x, y + bob);
    ctx.fillStyle = "#ffd700"; ctx.beginPath();
    ctx.moveTo(-22, 8); ctx.lineTo(-22, -6); ctx.lineTo(-12, 4); ctx.lineTo(0, -12);
    ctx.lineTo(12, 4); ctx.lineTo(22, -6); ctx.lineTo(22, 8); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffe066"; ctx.fillRect(-22, 8, 44, 6);
    ctx.fillStyle = "#ff5db1"; ctx.beginPath(); ctx.arc(0, 0, 3, 0, 7); ctx.fill();
    ctx.restore();
    label(x, stationY(STATIONS) + 40, "CROWN", 10, "#a05a20", "center");
  }

  function bean(p, id, name, hit, moving, won, t) {
    const col = id === "A" ? "#10b981" : "#8b5cf6";
    const soft = id === "A" ? "#5eead4" : "#c4b5fd";
    const hop = moving ? -Math.abs(Math.sin(t / 220 + (id === "A" ? 0 : 1.6))) * 18 : 0;
    const x = p.x, y = p.y + hop;
    shadow(p.x, p.y + 40, 16 - Math.min(10, Math.abs(hop) * 0.3), 6, 0.22);
    ctx.save(); ctx.translate(x, y);
    const bw = 30, bh = 38;
    ctx.fillStyle = shade(col, 0.7); rrect(-bw / 2 - 1, -bh / 2 + 2, bw + 2, bh, 15); ctx.fill();
    ctx.fillStyle = col; rrect(-bw / 2, -bh / 2, bw, bh, 15); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.45)"; rrect(-bw / 2 + 4, -bh / 2 + 4, 11, 16, 6); ctx.fill();
    ctx.fillStyle = soft + "aa"; rrect(-bw / 2 + 3, 4, bw - 6, 7, 3); ctx.fill();
    const ex = 6, ey = -6;
    for (const sgn of [-1, 1]) {
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(sgn * ex, ey, 6, 0, 7); ctx.fill();
      const px = hit ? sgn * 1.5 : 2.2, py = hit ? -2 : 1;
      ctx.fillStyle = "#1a1030"; ctx.beginPath(); ctx.arc(sgn * ex + px, ey + py, 2.6, 0, 7); ctx.fill();
    }
    ctx.strokeStyle = "#1a1030"; ctx.lineWidth = 1.8;
    if (hit) { ctx.fillStyle = "#5a1030"; ctx.beginPath(); ctx.ellipse(0, 8, 3.5, 5, 0, 0, 7); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(0, 5, 5, 0.2, Math.PI - 0.2); ctx.stroke(); }
    ctx.restore();
    // name tag
    const nm = name.toUpperCase(), w = Math.max(54, nm.length * 8);
    ctx.fillStyle = "rgba(40,12,40,.85)"; rrect(p.x - w / 2, p.y + 44, w, 16, 5); ctx.fill();
    label(p.x, p.y + 55, nm, 9, soft, "center");
    if (hit) {
      const sx = x, sy = y - 36;
      ctx.fillStyle = "rgba(255,255,255,0.95)"; rrect(sx - 26, sy - 14, 52, 20, 8); ctx.fill();
      label(sx, sy, "noooo!", 11, "#e23b6c", "center");
    }
  }

  function hud() {
    if (!data) return;
    const p = data.racers, rows = [[p[0], "#10b981", "#5eead4"], [p[1], "#8b5cf6", "#c4b5fd"]];
    ctx.fillStyle = "rgba(60,16,52,.8)"; rrect(12, 44, 262, 74, 12); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; rrect(12.5, 44.5, 261, 73, 12); ctx.stroke();
    label(24, 60, "RACE TO THE CROWN", 9, "rgba(255,225,180,0.9)", "left");
    rows.forEach(([pr, col, soft], i) => {
      const y = 76 + i * 22;
      label(24, y + 4, pr.handle.toUpperCase().slice(0, 12), 10, soft, "left");
      bar(110, y - 4, 96, 9, pr.progress / GOAL, col);
      label(214, y + 4, pr.won ? "CROWN!" : pr.progress + "%", 9, pr.won ? "#ffd700" : soft, "left");
      label(252, y + 4, pr.wipes ? "💥" + pr.wipes : "—", 8, pr.wipes ? "#ff7aa8" : "rgba(255,255,255,0.4)", "left");
    });
    // odds pill (top-center) — kept clear of other top labels (HUD is below it)
    const a = oddsA(), pa = Math.round(a * 100), pb = 100 - pa;
    const bw = 248, x = (W - bw) / 2, yy = 7;
    ctx.fillStyle = "rgba(40,8,30,.86)"; rrect(x, yy, bw, 30, 9); ctx.fill();
    label(W / 2, yy + 12, "◷ LIVE ODDS", 8, "#ffb0d4", "center");
    label(x + 12, yy + 12, p[0].handle.toUpperCase().slice(0, 8) + " " + pa + "%", 9, "#5eead4", "left");
    label(x + bw - 12, yy + 12, pb + "% " + p[1].handle.toUpperCase().slice(0, 8), 9, "#c4b5fd", "right");
    const aw = Math.max(2, (bw - 24) * a);
    ctx.fillStyle = "#10b981"; rrect(x + 12, yy + 18, aw, 7, 3); ctx.fill();
    ctx.fillStyle = "#8b5cf6"; rrect(x + 12 + aw, yy + 18, bw - 24 - aw, 7, 3); ctx.fill();
  }
  function oddsA() {
    if (!data) return 0.5;
    const p = data.racers;
    const lead = (p[0].progress - p[1].progress) / 26, stab = (p[1].wipes - p[0].wipes) * 0.55;
    const f = (x) => 1 / (1 + Math.exp(-x));
    const a = f(lead + stab), b = f(-(lead + stab)); return a / (a + b);
  }

  function finish(t) {
    if (!data) return;
    const over = data.winner || data.status === "draw";
    if (!over) return;
    ctx.fillStyle = "rgba(40,8,36,.55)"; ctx.fillRect(0, 0, W, H);
    const draw = !data.winner;
    const col = draw ? "#cbb6c6" : data.winner === data.racers[0].handle ? "#34d399" : "#a855f7";
    const title = draw ? "PHOTO FINISH" : data.win_reason === "closer" ? "TIME UP" : "CROWNED!";
    const sub = draw ? "Both beans dead level"
      : data.win_reason === "crown" ? data.winner + " bounced onto the crown first"
      : data.winner + " was closest to the crown";
    label(W / 2, H / 2 - 16, title, draw ? 38 : 40, col, "center");
    label(W / 2, H / 2 + 18, sub, 16, "#fff0f6", "center");
    if (!draw) for (let i = 0; i < 80; i++) {
      const sx = (i * 137.5) % W, fall = (t / 9 + i * 60) % (H + 60), sway = Math.sin(t / 400 + i) * 14;
      ctx.fillStyle = PASTELS[i % PASTELS.length];
      ctx.save(); ctx.translate(sx + sway, fall - 30); ctx.rotate(t / 300 + i);
      ctx.fillRect(-3, -3, 6, 6); ctx.restore();
    }
  }
  function vignette() {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H * 0.85);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(60,10,50,0.4)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function frame(t) {
    candyVoid(t); clouds(t); voidGoo(t);
    const seed = data ? Number(data.seed) || 1 : 1;
    const twist = data ? Number(data.twist_station) : -1;
    platforms(t, seed, twist);
    obstacles(t, seed, twist);
    crownGoal(t, !!(data && data.winner && data.win_reason === "crown"));
    if (data) {
      const p = data.racers;
      for (let i = 0; i < 2; i++) shown[i] += (p[i].progress - shown[i]) * 0.12;
      const pos = [0, 1].map(i => progPos(p[i].won ? GOAL : shown[i]));
      // draw trailing bean first so the leader is on top
      const order = p[0].progress >= p[1].progress ? [1, 0] : [0, 1];
      const moving = !data.winner;
      for (const i of order) {
        const hit = p[i].ragdoll === true || p[i].last === "wipeout" || p[i].last === "mistime";
        bean(pos[i], i ? "B" : "A", p[i].handle, hit && moving, moving, p[i].won, t);
      }
      hud();
      finish(t);
    }
    vignette();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- tiny helpers ----
  function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function label(x, y, t, px, c, al) { ctx.fillStyle = c; ctx.textAlign = al || "left"; ctx.font = `700 ${px}px ui-monospace,monospace`; ctx.fillText(t, x, y); }
  function bar(x, y, w, h, f, c) { ctx.fillStyle = "#3a1030"; rrect(x, y, w, h, h / 2); ctx.fill(); ctx.fillStyle = c; rrect(x, y, Math.max(2, w * clamp(f, 0, 1)), h, h / 2); ctx.fill(); ctx.fillStyle = "rgba(255,255,255,0.3)"; rrect(x, y, Math.max(2, w * clamp(f, 0, 1)), h / 2, h / 4); ctx.fill(); }
  function glow(x, y, r, c) { const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, c); g.addColorStop(1, c.replace(/[\d.]+\)$/, "0)")); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
  function shadow(x, y, rx, ry, a) { ctx.fillStyle = `rgba(40,10,40,${a})`; ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, 7); ctx.fill(); }
  function shade(hex, m) { const c = hex.replace("#", ""); const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16); const f = (v) => Math.max(0, Math.min(255, Math.round(v * m))); return `rgb(${f(r)},${f(g)},${f(b)})`; }
})();
