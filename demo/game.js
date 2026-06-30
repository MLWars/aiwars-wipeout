/* Wipeout Gauntlet — a pastel candy-voxel obstacle gauntlet. Two jelly-bean
 * racers (Champions) bounce across crumble-tile platforms over a pink void,
 * dodging spinning hammers and swinging pendulums toward a confetti CROWN.
 *
 * Their PUBLIC PROMPT is a risk doctrine: RUSH ahead (big ground, high
 * knockdown risk), TIME the swing (wait for the hammer to pass — safe but slow),
 * or hug the SAFE edge (small guaranteed steps). A hit = RAGDOLL launch + lost
 * ground ("noooo!"). First to the crown (progress >= goal) is crowned.
 *
 * HIDDEN TWIST: one obstacle's swing timing is seeded-random, so two identical
 * doctrines don't always resolve the same way — the odds stay live.
 *
 * Faithful to the engine Game-trait model: turn-based, opaque move-strings, the
 * agent plays via get_state -> legal_moves -> make_move(mv, ply). The prompt
 * decides which legal move it picks each turn.
 */
(function () {
  const A = window.AW;
  const W = 780, H = 560;
  const GOAL = 100, STATIONS = 6;

  // The course runs left->right across the canvas; each station is a platform.
  // The CROWN sits ON the last station so the full width is always in play.
  const TRACK_X0 = 96, TRACK_X1 = W - 118;
  const TRACK_Y = 320;                       // baseline of the platforms
  const stationX = (s) => TRACK_X0 + (TRACK_X1 - TRACK_X0) * (s / STATIONS);
  // a gentle wave so platforms rise & dip across the run
  const stationY = (s) => TRACK_Y + Math.sin(s * 0.95 + 0.6) * 24 - s * 5.2;
  const CROWN = { x: stationX(STATIONS), y: stationY(STATIONS) - 92 };

  // map progress 0..GOAL -> a screen position interpolating between stations.
  // a mild ease so the field spreads across the whole track (no dead right half):
  // even a modest lead pulls a bean well past the midpoint.
  function progPos(prog) {
    const raw = A.clamp(prog / GOAL, 0, 1);
    const eased = Math.pow(raw, 0.82);          // bias outward → fills the right
    const f = eased * STATIONS;
    const s0 = Math.min(STATIONS - 1, Math.floor(f)), s1 = Math.min(STATIONS, s0 + 1), tt = f - s0;
    return { x: A.lerp(stationX(s0), stationX(s1), tt), y: A.lerp(stationY(s0), stationY(s1), tt), station: s0 };
  }

  // ---- doctrine: parse the public prompt into a movement policy -------------
  const KW = {
    rush: ["rush", "fast", "reckless", "send", "yolo", "ahead", "charge", "blitz", "aggressive", "speed", "sprint", "barrel", "full send"],
    timer: ["careful", "time", "patient", "safe", "wait", "swing", "dodge", "cautious", "measured", "edge", "steady", "watch"],
  };
  function doctrine(prompt) {
    const p = (prompt || "").toLowerCase();
    let r = 0, ti = 0;
    for (const k of KW.rush) if (p.includes(k)) r++;
    for (const k of KW.timer) if (p.includes(k)) ti++;
    if (r === 0 && ti === 0) return { kind: "balanced", tag: "bouncy improviser", rush: 0.5 };
    if (r > ti) return { kind: "rush", tag: "reckless rusher", rush: 0.85 };
    if (ti > r) return { kind: "timer", tag: "patient dodger", rush: 0.18 };
    return { kind: "balanced", tag: "bouncy improviser", rush: 0.5 };
  }
  function highlight(prompt) {
    let h = prompt || "";
    h = h.replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
    for (const k of [...KW.rush, ...KW.timer]) {
      h = h.replace(new RegExp("\\b(" + k.replace(/ /g, "\\s") + ")\\b", "ig"), "<b>$1</b>");
    }
    return h;
  }

  const DEF_A = "Full send! Rush ahead every turn, charge through the hammers — speed beats caution. We barrel to the crown before anyone else gets close. Yolo.";
  const DEF_B = "Stay patient. Time every swing, wait for the hammer to pass, hug the safe edge. Slow and careful beats reckless — let them wipe out while I dodge to the crown.";

  // ---- the deterministic engine --------------------------------------------
  function build(seed, opts) {
    const rng = A.rng(seed);
    const prompts = { A: (opts.prompts && opts.prompts.A) || DEF_A, B: (opts.prompts && opts.prompts.B) || DEF_B };
    const doc = { A: doctrine(prompts.A), B: doctrine(prompts.B) };

    // hidden seeded twist: one station's swing timing is secretly off-beat, so
    // a "timed" dodge there can mistime and a reckless rush can sail through.
    const twistStation = 2 + Math.floor(rng() * (STATIONS - 2));   // 2..STATIONS-1
    const twistPhase = rng();                                       // where the hammer is on the twist tick

    // each station obstacle: spinning hammer (h) or pendulum (p), base phase
    const obstacles = [];
    for (let s = 0; s <= STATIONS; s++) {
      const r = A.rng(seed * 71 + s * 13);
      obstacles.push({ kind: r() < 0.5 ? "hammer" : "pendulum", phase: r(), crumble: r() < 0.4 });
    }

    // resolve a chosen move at a station -> {progress, hit, mistime}
    function resolveMove(kind, station, who) {
      const r = A.rng(seed * 911 + station * 29 + (who === "A" ? 1 : 7));
      const onTwist = station === twistStation;
      // hammer is "dangerous" on this tick when its phase falls in a window
      const swingPhase = onTwist ? twistPhase : (obstacles[Math.min(STATIONS, station)].phase + r() * 0.18);
      const dangerOpen = swingPhase > 0.30 && swingPhase < 0.70; // hammer overhead -> bad to be here

      if (kind === "rush:ahead") {
        // big ground, but if the hammer's overhead you get clobbered (twist can flip it)
        const hit = dangerOpen ? r() < 0.66 : r() < 0.30;
        return { progress: hit ? 6 + r() * 4 : 22 + r() * 8, hit, mistime: onTwist && hit };
      }
      if (kind === "time:swing") {
        // wait for the swing to pass; safe medium progress — UNLESS this is the
        // seeded-twist station where the timing is off and you misread it.
        const mistime = onTwist && r() < 0.55;
        const hit = mistime;
        return { progress: hit ? 7 + r() * 3 : 16 + r() * 5, hit, mistime };
      }
      // safe:edge — small guaranteed step, almost never hit
      const hit = r() < 0.05;
      return { progress: hit ? 4 + r() * 2 : 11 + r() * 4, hit, mistime: false };
    }

    function choose(d, station) {
      // doctrine -> which legal move; balanced flips on a per-station coin
      if (d.kind === "rush") return "rush:ahead";
      if (d.kind === "timer") return station % 3 === 1 ? "safe:edge" : "time:swing";
      const r = A.rng(seed * 53 + station * 3);
      return r() < 0.5 ? "rush:ahead" : "time:swing";
    }

    const st = {
      A: { prog: 0, station: 0, wipes: 0, won: false, ragdoll: 0 },
      B: { prog: 0, station: 0, wipes: 0, won: false, ragdoll: 0 },
    };
    const beats = [];
    const oddsHist = [];
    let ply = 1, winner = undefined, winReason = "crown", done = false;

    function snapOdds() {
      const f = (me, op) => {
        const lead = (st[me].prog - st[op].prog) / 26;
        const stab = (st[op].wipes - st[me].wipes) * 0.55;
        return 1 / (1 + Math.exp(-(lead + stab)));
      };
      let a = f("A", "B"), b = f("B", "A");
      const s = a + b; return { A: (a / s) * 100, B: (b / s) * 100 };
    }
    oddsHist.push(snapOdds());

    const LEGAL = ["rush:ahead", "time:swing", "safe:edge"];

    for (let round = 0; round < STATIONS + 4 && !done; round++) {
      for (const id of ["A", "B"]) {
        if (done) break;
        const me = st[id], op = st[id === "A" ? "B" : "A"];
        if (me.won) continue;
        const station = me.station;
        const move = choose(doc[id], station);
        const res = resolveMove(move, station, id);
        const fromProg = me.prog;
        me.prog = Math.min(GOAL, me.prog + res.progress);

        let knock = 0;
        if (res.hit) {
          me.wipes++;
          knock = 7 + Math.floor(rng() * 6);
          me.prog = Math.max(0, me.prog - knock);
          me.ragdoll = 1;
        } else {
          me.ragdoll = 0;
        }
        me.station = Math.min(STATIONS, Math.floor(me.prog / GOAL * STATIONS));

        let result, ok = true;
        if (me.prog >= GOAL) { me.won = true; result = "CROWNED · reached the crown!"; }
        else if (res.hit) { result = "WIPEOUT · ragdolled -" + knock + " · prog " + Math.round(me.prog) + "%"; ok = true; }
        else result = "ok · +" + Math.round(res.progress) + " · prog " + Math.round(me.prog) + "%";

        const obKind = obstacles[Math.min(STATIONS, station)].kind;
        const thought = doc[id].kind === "rush"
          ? "No time to read the swing — full send, barrel through!"
          : doc[id].kind === "timer"
            ? (move === "safe:edge" ? "Hug the edge, no heroics — small safe step." : "Watch the arc... wait for it to pass, then go.")
            : "Read the gap and improvise — best ground I can grab.";

        beats.push({
          ply: ply++, agent: id,
          thought,
          observe: {
            station: "st" + (station + 1) + "/" + STATIONS, obstacle: obKind,
            to_crown: Math.max(0, GOAL - Math.round(me.prog)), wipes: me.wipes,
          },
          legal: LEGAL.slice(),
          move, ok, result,
          state: {
            A: { ...st.A }, B: { ...st.B }, mover: id,
            move, hit: res.hit, mistime: res.mistime, knock, fromProg, toProg: me.prog,
            station, obKind, twistStation, swingDanger: res.hit && move !== "safe:edge",
          },
          events: [eventLine(id, move, res, knock, me)],
        });
        oddsHist.push(snapOdds());

        if (me.won) { winner = id; winReason = "crown"; done = true; }
      }
    }

    // resolve no-crown end (ran out of rounds): closer wins
    if (winner === undefined) {
      winner = st.A.prog === st.B.prog ? null : st.A.prog > st.B.prog ? "A" : "B";
      winReason = winner == null ? "tie" : "closer";
    }

    function nameOf(id) { return id === "A" ? "Beanzo" : "Tumble"; }
    function eventLine(id, move, res, knock, me) {
      const nm = nameOf(id);
      if (res.hit) return `${nm} ${move === "time:swing" ? "mistimes the swing" : "eats the hammer"} — RAGDOLL, "noooo!" −${knock} ground`;
      if (me.won) return `${nm} bounces onto the crown platform — CROWNED!`;
      if (move === "rush:ahead") return `${nm} barrels ahead — clean line, +${Math.round(res.progress)} ground`;
      if (move === "time:swing") return `${nm} times the swing and slips past — +${Math.round(res.progress)}`;
      return `${nm} hugs the safe edge — small but clean, +${Math.round(res.progress)}`;
    }
    function finalLine() {
      if (winner == null) return "Photo finish — both beans dead level. Draw.";
      const loser = winner === "A" ? "B" : "A";
      if (winReason === "crown") return `${nameOf(winner)} bounces onto the crown first — gauntlet cleared!`;
      return `Rounds up — ${nameOf(winner)} was closest to the crown (${nameOf(loser)} couldn't close it).`;
    }

    beats.push({
      ply: ply++, agent: "ref", move: "resolve", legal: null,
      observe: { winner: winner == null ? "draw" : nameOf(winner), reason: winReason },
      result: winner == null ? "draw — dead level" : nameOf(winner) + " wins · " + winReason,
      events: [finalLine()],
      state: { A: { ...st.A }, B: { ...st.B }, mover: null, final: true },
    });

    return {
      seed, beats, winner, winReason,
      names: { A: nameOf("A"), B: nameOf("B") },
      promptOf: (id) => highlight(prompts[id]),
      tagOf: (id) => doc[id].tag,
      oddsAt: (b) => oddsHist[Math.min(b, oddsHist.length - 1)] || { A: 50, B: 50 },
      _doc: doc, _twistStation: twistStation, _obstacles: obstacles,
    };
  }

  // ====== RENDER =============================================================
  // bean screen position for current beat, interpolated + with a doctrine-styled
  // bounce. The RUSHER barrels in long low leaps (and ragdolls hard on a hit);
  // the DODGER hangs back, times the swing, then hops — so reading the prompt
  // predicts the on-screen movement style.
  function beanPos(res, beat, beatT) {
    const out = { A: null, B: null };
    for (const id of ["A", "B"]) {
      const kind = res._doc[id] ? res._doc[id].kind : "balanced";
      let cur = null;
      for (let k = 0; k <= beat; k++) if (res.beats[k].agent === id) cur = res.beats[k];
      if (!cur) { const p = progPos(0); out[id] = { x: p.x, y: p.y, hopY: 0, ragT: 0, hit: false, moving: false, kind, lean: 0, charge: 0 }; continue; }
      const active = res.beats[beat] && res.beats[beat].agent === id && res.beats[beat].state && !res.beats[beat].state.final;
      const move = cur.state.move;
      const hit = cur.state.hit;

      // doctrine-styled timing curve along the path:
      //  rusher  → almost no wind-up, explodes forward early, slight overshoot
      //  dodger  → a clear PAUSE (reads the swing) then a crisp late hop
      let prog01;        // 0..1 along-path travel
      let hopY = 0;      // vertical bounce arc
      let lean = 0;      // body tilt (rusher leans into the run)
      let charge = 0;    // 0..1 wind-up crouch (dodger telegraphs the time)
      if (active) {
        const bt = beatT;
        if (kind === "rush") {
          // long, low, fast leap: quick launch, shallow arc, lands and slides
          const tt = A.clamp((bt - 0.04) / 0.96, 0, 1);
          prog01 = 1 - Math.pow(1 - tt, 2.4);                 // explosive front-load
          hopY = -Math.abs(Math.sin(prog01 * Math.PI)) * (hit ? 14 : 20);
          lean = (0.18 + Math.sin(prog01 * Math.PI) * 0.34);  // dives forward (low, fast)
        } else if (kind === "timer") {
          // pause-and-read, then hop. travel stays ~0 for the first ~45%.
          if (bt < 0.45) { prog01 = 0; charge = A.ease(bt / 0.45); hopY = -charge * 4; }
          else { const tt = (bt - 0.45) / 0.55; prog01 = A.easeOut(tt); charge = 1 - tt; hopY = -Math.abs(Math.sin(tt * Math.PI)) * 34 * (1 - 0.3 * tt); }
        } else {
          prog01 = A.easeOut(bt);
          hopY = -Math.abs(Math.sin(bt * Math.PI)) * 28 * (1 - 0.35 * bt);
        }
      } else { prog01 = 1; }

      const fp = progPos(cur.state.fromProg), tp = progPos(cur.state.toProg);
      const x = A.lerp(fp.x, tp.x, prog01), y = A.lerp(fp.y, tp.y, prog01);
      const ragT = active && hit ? beatT : 0;       // ragdoll only during the active hit beat
      out[id] = { x, y, hopY, ragT, hit, mistime: !!cur.state.mistime, moving: active && beatT < 0.95, station: cur.state.station, kind, move, lean, charge };
    }
    return out;
  }

  function draw(ctx, v) {
    const t = v.t, res = v.result, beat = v.beat, bt = res.beats[beat];
    const stt = bt && bt.state ? bt.state : { A: { prog: 0, wipes: 0 }, B: { prog: 0, wipes: 0 } };

    candyVoid(ctx, t);
    cloudsBack(ctx, t);
    voidGoo(ctx, t);
    trackPlatforms(ctx, res, t, stt, bt);
    obstacleLayer(ctx, res, t, v);
    crownGoal(ctx, t, res.winner != null && v.over);

    const beans = beanPos(res, beat, v.beatT);
    // draw trailing bean first so leader is on top
    const order = (stt.A && stt.B && stt.A.prog >= stt.B.prog) ? ["B", "A"] : ["A", "B"];
    for (const id of order) if (beans[id]) bean(ctx, beans[id], id, t, v);
    // name tags as a separate pass so we can de-collide them
    nameTags(ctx, beans, res.names);
    // floaters: +N on a clean move, MISTIMED! callout on a twist mistime
    moveFloaters(ctx, res, beans, bt, v);

    foregroundCandy(ctx, t);
    hud(ctx, res, stt, t);
    announcer(ctx, res, bt, v);

    if (v.over) finishOverlay(ctx, res, t);
    vignette(ctx);
  }

  // --- scene pieces ----------------------------------------------------------
  const PASTELS = ["#ffd1e8", "#c9f0ff", "#fff3b0", "#d4ffd6", "#e6d1ff", "#ffe0c2"];

  function candyVoid(ctx, t) {
    // pink dreamy void gradient
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#ff9ec7");
    g.addColorStop(0.42, "#ffb3d1");
    g.addColorStop(0.66, "#ff86b8");
    g.addColorStop(1, "#e85a9b");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // soft sun-glow
    A.glow(ctx, W * 0.5, 92, 220, "rgba(255,250,220,0.45)");
    ctx.fillStyle = "#fff6e0"; ctx.beginPath(); ctx.arc(W * 0.5, 92, 38, 0, 7); ctx.fill();
    // floating sprinkle bokeh
    if (!A.reduced) for (let i = 0; i < 34; i++) {
      const x = (i * 151 + t * 0.012 * (1 + (i % 3))) % W;
      const y = (i * 83) % (H - 120);
      const tw = (Math.sin(t / 800 + i) + 1) / 2;
      ctx.fillStyle = PASTELS[i % PASTELS.length] + (i % 2 ? "55" : "33");
      ctx.beginPath(); ctx.arc(x, y, 2 + (i % 3) + tw * 1.5, 0, 7); ctx.fill();
    }
  }
  function cloudsBack(ctx, t) {
    const spec = [[90, 130, 60], [330, 100, 46], [560, 120, 54], [690, 150, 64], [200, 200, 40]];
    for (const [bx, by, r] of spec) {
      const x = bx + (A.reduced ? 0 : Math.sin(t / 4000 + bx) * 14);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(x, by, r * 0.6, 0, 7);
      ctx.arc(x + r * 0.5, by + 6, r * 0.5, 0, 7);
      ctx.arc(x - r * 0.5, by + 8, r * 0.42, 0, 7);
      ctx.arc(x + r * 0.15, by - r * 0.25, r * 0.45, 0, 7);
      ctx.fill();
    }
  }
  function voidGoo(ctx, t) {
    // wobbling candy-syrup pool at the bottom (what you fall into)
    const baseY = H - 64;
    ctx.fillStyle = "#d6347e";
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 24) {
      const y = baseY + Math.sin(x * 0.03 + t / 500) * 7 + Math.cos(x * 0.07 + t / 700) * 4;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    // glossy top highlight
    ctx.strokeStyle = "rgba(255,200,230,0.6)"; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 24) {
      const y = baseY + Math.sin(x * 0.03 + t / 500) * 7 + Math.cos(x * 0.07 + t / 700) * 4;
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    // bubbles
    if (!A.reduced) for (let i = 0; i < 10; i++) {
      const x = (i * 97 + t * 0.02) % W;
      const ph = (t / 1400 + i * 0.27) % 1;
      const y = H - 6 - ph * 46;
      ctx.fillStyle = `rgba(255,210,235,${0.5 * (1 - ph)})`;
      ctx.beginPath(); ctx.arc(x, y, 3 + (i % 3), 0, 7); ctx.fill();
    }
  }

  function trackPlatforms(ctx, res, t, stt, bt) {
    // the final station (STATIONS) is the crown pedestal — drawn by crownGoal.
    for (let s = 0; s < STATIONS; s++) {
      const x = stationX(s), y = stationY(s);
      const r = A.rng(res.seed * 71 + s * 13);
      r(); // align with obstacle rng
      const ob = res._obstacles[s];
      const col = PASTELS[s % PASTELS.length];
      const wTop = 78, hSide = 56, dep = 18;
      // crumble tiles get a cracked, jittering look
      const crumble = ob.crumble;
      const jitter = crumble && !A.reduced ? Math.sin(t / 160 + s) * 1.2 : 0;
      // shadow on goo
      A.shadow(ctx, x, stationY(s) + 92, 46, 12, 0.18);
      // 3D candy block
      drawCandyBlock(ctx, x - wTop / 2 + jitter, y, wTop, hSide, dep, col, crumble, t, s);
      // station marker number
      A.label(ctx, x, y - hSide / 2 + 4, String(s + 1), 13, "rgba(90,40,80,0.55)", "center");
      // twist station has a subtle warning shimmer
      if (s === res._twistStation && !A.reduced) {
        const a = 0.3 + 0.3 * Math.sin(t / 220);
        ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = 2;
        A.rrect(ctx, x - wTop / 2 - 3, y - 3, wTop + 6, 6, 3); ctx.stroke();
      }
    }
  }
  function drawCandyBlock(ctx, x, y, w, h, d, col, crumble, t, s) {
    // top face
    ctx.fillStyle = shade(col, 1.12);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w + d, y - d); ctx.lineTo(x + d, y - d); ctx.closePath(); ctx.fill();
    // side face
    ctx.fillStyle = shade(col, 0.74);
    ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w + d, y - d); ctx.lineTo(x + w + d, y - d + h); ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill();
    // front face (rounded candy)
    ctx.fillStyle = col; A.rrect(ctx, x, y, w, h, 8); ctx.fill();
    // glossy top stripe
    ctx.fillStyle = "rgba(255,255,255,0.4)"; A.rrect(ctx, x + 4, y + 4, w - 8, 8, 4); ctx.fill();
    // sprinkle dots
    const r = A.rng(s * 991 + 3);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = PASTELS[(s + i + 2) % PASTELS.length];
      ctx.fillRect(x + 8 + r() * (w - 16), y + 18 + r() * (h - 24), 4, 4);
    }
    // crumble cracks
    if (crumble) {
      ctx.strokeStyle = "rgba(120,50,90,0.35)"; ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(x + w * 0.3, y); ctx.lineTo(x + w * 0.42, y + h * 0.5); ctx.lineTo(x + w * 0.34, y + h);
      ctx.moveTo(x + w * 0.65, y); ctx.lineTo(x + w * 0.58, y + h * 0.6);
      ctx.stroke();
    }
  }

  function obstacleLayer(ctx, res, t, v) {
    const tt = A.reduced ? 0 : t;
    for (let s = 0; s <= STATIONS; s++) {
      if (s === 0 || s === STATIONS) continue;
      const ob = res._obstacles[s];
      const x = stationX(s), topY = stationY(s) - 78;
      if (ob.kind === "hammer") spinningHammer(ctx, x, topY, ob.phase, tt, s === res._twistStation);
      else pendulum(ctx, x, stationY(s) - 110, ob.phase, tt, s === res._twistStation);
    }
  }
  function spinningHammer(ctx, x, y, phase, t, twist) {
    // a rotating candy mallet on a post above the platform
    const ang = (t / 620) + phase * Math.PI * 2;
    // post
    ctx.fillStyle = "#b86fb0"; ctx.fillRect(x - 4, y, 8, 70);
    ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(x - 4, y, 3, 70);
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    // arm
    ctx.fillStyle = "#9d4edd"; A.rrect(ctx, -6, -4, 54, 8, 4); ctx.fill();
    // mallet head (candy)
    const hx = 50;
    ctx.fillStyle = twist ? "#ff5db1" : "#7b2ff7";
    A.rrect(ctx, hx - 12, -16, 26, 32, 8); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)"; A.rrect(ctx, hx - 9, -13, 8, 26, 4); ctx.fill();
    // candy stripes
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2;
    for (let i = -1; i < 2; i++) { ctx.beginPath(); ctx.moveTo(hx - 12, i * 9); ctx.lineTo(hx + 14, i * 9 - 6); ctx.stroke(); }
    ctx.restore();
    // hub
    ctx.fillStyle = "#5a189a"; ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fill();
    ctx.fillStyle = "#c77dff"; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill();
  }
  function pendulum(ctx, x, y, phase, t, twist) {
    const sw = Math.sin(t / 560 + phase * Math.PI * 2) * 0.9;
    const len = 96;
    // pivot beam
    ctx.fillStyle = "#b86fb0"; ctx.fillRect(x - 36, y - 8, 72, 8);
    ctx.save(); ctx.translate(x, y); ctx.rotate(sw);
    ctx.strokeStyle = "rgba(120,60,110,0.8)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, len); ctx.stroke();
    // candy wrecking ball
    const by = len;
    A.glow(ctx, 0, by, 26, twist ? "rgba(255,93,177,0.4)" : "rgba(168,85,247,0.35)");
    ctx.fillStyle = twist ? "#ff5db1" : "#9d4edd";
    ctx.beginPath(); ctx.arc(0, by, 17, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.beginPath(); ctx.arc(-5, by - 5, 6, 0, 7); ctx.fill();
    // swirl
    ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, by, 11, 0.4, 3.6); ctx.stroke();
    ctx.restore();
  }

  function crownGoal(ctx, t, won) {
    const x = CROWN.x, y = CROWN.y;
    // pedestal platform
    drawCandyBlock(ctx, x - 40, stationY(STATIONS), 80, 56, 18, "#fff3b0", false, t, 99);
    // glow
    A.glow(ctx, x, y + 30, 70, won ? "rgba(255,215,0,0.6)" : "rgba(255,225,120,0.35)");
    // floating crown
    const bob = A.reduced ? 0 : Math.sin(t / 500) * 5;
    ctx.save(); ctx.translate(x, y + bob);
    // crown base
    ctx.fillStyle = "#ffd700";
    ctx.beginPath();
    ctx.moveTo(-22, 8); ctx.lineTo(-22, -6); ctx.lineTo(-12, 4); ctx.lineTo(0, -12);
    ctx.lineTo(12, 4); ctx.lineTo(22, -6); ctx.lineTo(22, 8); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffe066"; ctx.fillRect(-22, 8, 44, 6);
    // jewels
    ctx.fillStyle = "#ff5db1"; ctx.beginPath(); ctx.arc(0, 0, 3, 0, 7); ctx.fill();
    ctx.fillStyle = "#5ec8ff"; ctx.beginPath(); ctx.arc(-12, 6, 2.4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(12, 6, 2.4, 0, 7); ctx.fill();
    // sparkle
    if (!A.reduced) { const a = (Math.sin(t / 240) + 1) / 2; ctx.fillStyle = `rgba(255,255,255,${0.4 + a * 0.5})`; ctx.fillRect(-1, -22, 2, 8); ctx.fillRect(-4, -18, 8, 2); }
    ctx.restore();
    A.label(ctx, x, stationY(STATIONS) + 40, "CROWN", 10, "#a05a20", "center");
  }

  function bean(ctx, p, id, t, v) {
    const col = id === "A" ? "#10b981" : "#8b5cf6";
    const soft = id === "A" ? "#5eead4" : "#c4b5fd";
    const x = p.x, y = p.y + p.hopY;
    // ragdoll: spin + arc launch. The RUSHER ragdolls harder (longer launch,
    // more spin) than the cautious dodger — the reckless doctrine made visible.
    let rot = 0, lx = 0, ly = 0;
    if (p.ragT > 0) {
      const k = p.ragT;
      const hard = p.kind === "rush" ? 1.4 : p.kind === "timer" ? 0.8 : 1;
      rot = k * Math.PI * 3.2 * hard * (id === "A" ? 1 : -1);
      lx = -k * 34 * hard * (1 - k);             // launched backward
      ly = -Math.sin(k * Math.PI) * 48 * hard;   // arc up then down
    } else {
      // forward lean for the rusher, crouch tilt is handled by scale below
      rot = (p.lean || 0) * (id === "A" ? 1 : 1);
    }
    // shadow on platform
    A.shadow(ctx, p.x, p.y + 40, 18 - Math.min(10, Math.abs(p.hopY) * 0.3), 6, 0.22);

    // RUSHER speed-streak: a comet trail behind a barreling bean — the reckless
    // "full send" doctrine readable even in a still frame.
    if (p.kind === "rush" && p.moving && p.ragT === 0 && !A.reduced) {
      for (let i = 1; i <= 4; i++) {
        const k = i / 5, tx = x - i * 9, ty = y + p.hopY * (1 - k) * 0.4;
        ctx.globalAlpha = 0.16 * (1 - k);
        ctx.fillStyle = soft;
        A.rrect(ctx, tx - 13, ty - 17, 26, 34, 13); ctx.fill();
      }
      ctx.globalAlpha = 1;
      // forward whoosh lines
      ctx.strokeStyle = soft + "88"; ctx.lineWidth = 2; ctx.lineCap = "round";
      for (let i = 0; i < 3; i++) { const ly2 = y + p.hopY - 8 + i * 9; ctx.beginPath(); ctx.moveTo(x - 18 - i * 5, ly2); ctx.lineTo(x - 30 - i * 7, ly2); ctx.stroke(); }
    }
    // DODGER timing-tell: a little "…" thought beat while it reads the swing.
    if (p.kind === "timer" && (p.charge || 0) > 0.25 && p.hopY > -6 && p.ragT === 0) {
      const a = 0.5 + 0.5 * Math.sin(t / 120);
      A.label(ctx, x + 18, y - 22, "…", 18, `rgba(196,181,253,${a})`, "center");
      A.label(ctx, x, y - 30, "timing…", 8, "rgba(196,181,253,0.8)", "center");
    }

    ctx.save();
    ctx.translate(x + lx, y + ly);
    ctx.rotate(rot);
    // squash/stretch: hop stretches tall; the dodger's wind-up CROUCH squashes
    // wide (a clear "timing it..." tell before the late hop).
    const crouch = (p.charge || 0) * (p.hopY > -6 ? 1 : 0);
    const stretch = p.hopY < -4 ? 1.12 : (1 - 0.18 * crouch);
    ctx.scale(1 / stretch, stretch);

    // jelly-bean body (rounded capsule)
    const bw = 30, bh = 38;
    // body shadow rim
    ctx.fillStyle = shade(col, 0.7);
    A.rrect(ctx, -bw / 2 - 1, -bh / 2 + 2, bw + 2, bh, 15); ctx.fill();
    // main body
    ctx.fillStyle = col;
    A.rrect(ctx, -bw / 2, -bh / 2, bw, bh, 15); ctx.fill();
    // glossy highlight
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    A.rrect(ctx, -bw / 2 + 4, -bh / 2 + 4, 11, 16, 6); ctx.fill();
    // candy belly stripe
    ctx.fillStyle = soft + "aa";
    A.rrect(ctx, -bw / 2 + 3, 4, bw - 6, 7, 3); ctx.fill();
    // big googly eyes
    const ex = 6, ey = -6;
    for (const sgn of [-1, 1]) {
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(sgn * ex, ey, 6, 0, 7); ctx.fill();
      // pupil looks toward crown (right) normally; up/cross-eyed when hit
      const px = p.hit ? sgn * 1.5 : 2.2, py = p.hit ? -2 : 1;
      ctx.fillStyle = "#1a1030"; ctx.beginPath(); ctx.arc(sgn * ex + px, ey + py, 2.6, 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.beginPath(); ctx.arc(sgn * ex + px - 1, ey + py - 1, 0.9, 0, 7); ctx.fill();
    }
    // mouth: smile, or "o" of dismay when hit
    ctx.strokeStyle = "#1a1030"; ctx.lineWidth = 1.8;
    if (p.hit) {
      ctx.fillStyle = "#5a1030"; ctx.beginPath(); ctx.ellipse(0, 8, 3.5, 5, 0, 0, 7); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(0, 5, 5, 0.2, Math.PI - 0.2); ctx.stroke();
    }
    // little arms (bounce up when moving)
    ctx.strokeStyle = shade(col, 0.6); ctx.lineWidth = 3; ctx.lineCap = "round";
    const armUp = p.moving || p.hit ? -8 : -2;
    ctx.beginPath(); ctx.moveTo(-bw / 2, 2); ctx.lineTo(-bw / 2 - 6, 2 + armUp); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bw / 2, 2); ctx.lineTo(bw / 2 + 6, 2 + armUp); ctx.stroke();
    ctx.restore();

    // "noooo!" speech when hit (suppressed on a mistime — the MISTIMED! callout
    // is the headline there, so we don't double up the chatter)
    if (p.hit && !p.mistime && p.ragT > 0.05 && p.ragT < 0.9) {
      const sx = x + lx, sy = y + ly - 36;
      ctx.fillStyle = "rgba(255,255,255,0.95)"; A.rrect(ctx, sx - 26, sy - 14, 52, 20, 8); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.95)"; ctx.beginPath(); ctx.moveTo(sx - 4, sy + 6); ctx.lineTo(sx + 4, sy + 6); ctx.lineTo(sx, sy + 13); ctx.closePath(); ctx.fill();
      A.label(ctx, sx, sy, "noooo!", 11, "#e23b6c", "center");
    }
  }

  // name tags drawn after both beans so we can DE-COLLIDE them: when the two
  // beans share/adjoin a station the trailing tag drops a row and fades, so the
  // labels never stack on top of each other.
  function nameTags(ctx, beans, names) {
    const a = beans.A, b = beans.B;
    let collide = false;
    if (a && b) collide = Math.abs(a.x - b.x) < 64 && Math.abs(a.y - b.y) < 30;
    // the rear (lower-x, or lower bean) tag drops down + fades
    let rear = null;
    if (collide && a && b) rear = a.x <= b.x ? "A" : "B";
    for (const id of ["A", "B"]) {
      const p = beans[id]; if (!p) continue;
      const soft = id === "A" ? "#5eead4" : "#c4b5fd";
      const isRear = rear === id;
      const dy = isRear ? 20 : 0;            // drop the trailing tag a full row
      const alpha = isRear ? 0.55 : 1;       // and fade it
      const nm = names[id].toUpperCase();
      const w = Math.max(54, nm.length * 8);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "rgba(40,12,40,.85)"; A.rrect(ctx, p.x - w / 2, p.y + 44 + dy, w, 16, 5); ctx.fill();
      ctx.strokeStyle = (id === "A" ? "rgba(16,185,129," : "rgba(139,92,246,") + (isRear ? "0.4)" : "0.8)");
      ctx.lineWidth = 1; A.rrect(ctx, p.x - w / 2 + .5, p.y + 44.5 + dy, w - 1, 15, 5); ctx.stroke();
      A.label(ctx, p.x, p.y + 55 + dy, nm, 9, soft, "center");
      ctx.globalAlpha = 1;
    }
  }

  // rising "+N" on a clean move, and a big MISTIMED! callout when the hidden
  // twist bites a timed dodge — the "odds stay live" moment made loud.
  function moveFloaters(ctx, res, beans, bt, v) {
    if (!bt || !bt.state || bt.state.final) return;
    const id = bt.state.mover; if (!id || !beans[id]) return;
    const p = beans[id];
    const col = id === "A" ? "#5eead4" : "#c4b5fd";
    const gained = Math.max(0, Math.round((bt.state.toProg || 0) - (bt.state.fromProg || 0)));
    const bx = p.x + (p.hopY ? 0 : 0), by0 = p.y + p.hopY;

    if (bt.state.mistime) {
      // mistimed timed dodge — the twist station's swing was off-beat. This is the
      // headline "odds stay live" moment, so it sits ABOVE the ragdoll/noooo.
      const k = A.clamp(v.beatT, 0, 1);
      const pop = k < 0.18 ? A.easeOut(k / 0.18) : 1;
      const fade = k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1;
      ctx.globalAlpha = fade;
      const cy = by0 - 74;
      A.glow(ctx, bx, cy, 64, "rgba(255,93,177,0.5)");
      ctx.save(); ctx.translate(bx, cy); ctx.scale(pop, pop);
      ctx.fillStyle = "rgba(40,8,30,0.92)"; A.rrect(ctx, -74, -16, 148, 28, 8); ctx.fill();
      ctx.strokeStyle = "#ff5db1"; ctx.lineWidth = 2; A.rrect(ctx, -74, -16, 148, 28, 8); ctx.stroke();
      A.label(ctx, 0, 4, "MISTIMED!", 16, "#ff5db1", "center", "ui-monospace,monospace");
      // subtitle below the pill, clear of the ragdoll bubble
      A.label(ctx, 0, 26, "twist swing flipped", 9, "#ffd1e8", "center");
      ctx.restore();
      ctx.globalAlpha = 1;
    } else if (!bt.state.hit && gained >= 1) {
      // clean move: a +N floater rises and fades off the bean
      const k = A.clamp(v.beatT, 0, 1);
      const rise = A.easeOut(k) * 40;
      const fade = k < 0.12 ? k / 0.12 : (k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1);
      ctx.globalAlpha = A.clamp(fade, 0, 1);
      const fy = by0 - 30 - rise;
      ctx.fillStyle = "rgba(20,8,24,0.4)";
      A.label(ctx, bx + 1, fy + 1, "+" + gained, 17, "rgba(0,0,0,0.5)", "center", "ui-monospace,monospace");
      A.label(ctx, bx, fy, "+" + gained, 17, col, "center", "ui-monospace,monospace");
      ctx.globalAlpha = 1;
    }
  }

  function foregroundCandy(ctx, t) {
    // a few out-of-focus candy orbs drifting in the foreground for depth
    if (A.reduced) return;
    const spec = [[60, 470, 16, "#ffd1e8"], [720, 500, 20, "#c9f0ff"], [380, 530, 14, "#fff3b0"]];
    for (const [bx, by, r, c] of spec) {
      const x = bx + Math.sin(t / 1800 + bx) * 18;
      ctx.fillStyle = c + "66"; ctx.beginPath(); ctx.arc(x, by, r, 0, 7); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.beginPath(); ctx.arc(x - r * 0.3, by - r * 0.3, r * 0.3, 0, 7); ctx.fill();
    }
  }

  function hud(ctx, res, stt, t) {
    const rows = [["A", res.names.A, "#10b981", "#5eead4"], ["B", res.names.B, "#8b5cf6", "#c4b5fd"]];
    ctx.fillStyle = "rgba(60,16,52,.8)"; A.rrect(ctx, 12, 12, 262, 74, 12); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.lineWidth = 1; A.rrect(ctx, 12.5, 12.5, 261, 73, 12); ctx.stroke();
    A.label(ctx, 24, 28, "RACE TO THE CROWN", 9, "rgba(255,225,180,0.9)", "left");
    rows.forEach(([id, nm, col, soft], i) => {
      const y = 44 + i * 22; const s = stt[id] || { prog: 0, wipes: 0, won: false };
      A.label(ctx, 24, y + 4, nm.toUpperCase(), 10, soft, "left");
      bar(ctx, 96, y - 4, 110, 9, s.prog / GOAL, col, "#3a1030");
      A.label(ctx, 214, y + 4, s.won ? "CROWN!" : Math.round(s.prog) + "%", 9, s.won ? "#ffd700" : soft, "left");
      // wipe count
      let wstr = "";
      for (let k = 0; k < Math.min(4, s.wipes); k++) wstr += "x";
      A.label(ctx, 252, y + 4, s.wipes ? "💥" + s.wipes : "—", 8, s.wipes ? "#ff7aa8" : "rgba(255,255,255,0.4)", "left");
    });
  }
  function bar(ctx, x, y, w, h, frac, col, bg) {
    ctx.fillStyle = bg; A.rrect(ctx, x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = col; A.rrect(ctx, x, y, Math.max(2, w * A.clamp(frac, 0, 1)), h, h / 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.3)"; A.rrect(ctx, x, y, Math.max(2, w * A.clamp(frac, 0, 1)), h / 2, h / 4); ctx.fill();
  }

  function announcer(ctx, res, bt, v) {
    const h = 44; const y = H - h;
    ctx.fillStyle = "rgba(50,12,44,.92)"; ctx.fillRect(0, y, W, h);
    ctx.strokeStyle = "rgba(255,150,200,.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke();
    A.label(ctx, 16, y + 18, "📣 ANNOUNCER", 10, "#ff9ec7", "left");
    let line = "Two jelly-beans, one crown. Read each prompt — who barrels through the hammers, who waits to time the swing?";
    if (bt && bt.events && bt.events[0]) line = bt.events[0];
    if (v.over && res.beats.length) line = res.beats[res.beats.length - 1].events[0];
    A.wrap(ctx, line, 128, y + 18, W - 148, 14, 12, "#ffe5f1", "ui-monospace,monospace");
  }

  function finishOverlay(ctx, res, t) {
    ctx.fillStyle = "rgba(40,8,36,.55)"; ctx.fillRect(0, 0, W, H);
    const draw = res.winner == null;
    const col = draw ? "#cbb6c6" : res.winner === "A" ? "#34d399" : "#a855f7";
    A.glow(ctx, W / 2, H / 2 - 14, 240, (draw ? "rgba(203,182,198," : res.winner === "A" ? "rgba(52,211,153," : "rgba(168,85,247,") + "0.22)");
    const title = draw ? "PHOTO FINISH" : res.winReason === "closer" ? "TIME UP" : "CROWNED!";
    const loser = res.winner === "A" ? "B" : "A";
    const sub = draw ? "Both beans dead level"
      : res.winReason === "crown" ? res.names[res.winner] + " bounced onto the crown first"
      : res.names[res.winner] + " was closest to the crown";
    A.label(ctx, W / 2, H / 2 - 16, title, draw ? 38 : 40, col, "center", "ui-monospace,monospace");
    A.label(ctx, W / 2, H / 2 + 18, sub, 16, "#fff0f6", "center");
    // confetti rain
    if (!draw && !A.reduced) for (let i = 0; i < 90; i++) {
      const seedx = (i * 137.5) % W;
      const fall = (t / 9 + i * 60) % (H + 60);
      const sway = Math.sin(t / 400 + i) * 14;
      ctx.fillStyle = PASTELS[i % PASTELS.length];
      ctx.save(); ctx.translate(seedx + sway, fall - 30); ctx.rotate(t / 300 + i);
      ctx.fillRect(-3, -3, 6, 6); ctx.restore();
    }
    // a crown sparkle ring
    if (!draw && !A.reduced) for (let i = 0; i < 30; i++) {
      const a = (i / 30) * 7 + t / 500; const r = 70 + (i % 4) * 24;
      ctx.fillStyle = i % 2 ? col : "#ffd700";
      ctx.fillRect(W / 2 + Math.cos(a) * r, H / 2 - 14 + Math.sin(a) * r * 0.55, 3, 3);
    }
  }
  function vignette(ctx) {
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H * 0.85);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, "rgba(60,10,50,0.4)");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  // tint a hex color by a multiplier
  function shade(hex, m) {
    const c = hex.replace("#", "");
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    const f = (v) => Math.max(0, Math.min(255, Math.round(v * m)));
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }

  window.WIPEOUT = {
    id: "wipeout", name: "Wipeout Gauntlet", W, H,
    tag: "Two jelly-bean racers bounce through a candy-voxel obstacle course toward a crown. RUSH the hammers for big ground but risk a ragdoll wipeout; TIME the swings to slip past safe. First bean to the crown is crowned.",
    champions: [{ id: "A", name: "Beanzo", color: "#10b981" }, { id: "B", name: "Tumble", color: "#8b5cf6" }],
    prompts: { A: DEF_A, B: DEF_B },
    mcp: {
      kickoff: "You are a jelly-bean racer in a refereed candy gauntlet, played entirely through your tools. Each turn: get_state, legal_moves, then make_move with your move and the current ply. Bounce past the spinning hammers and swinging pendulums and reach the crown (progress 100%) before your rival. A hit ragdolls you backward.",
      tools: [
        { name: "get_state", args: "", ret: "{station, obstacle, to_crown, wipes}", desc: "Read the gauntlet: your station, the obstacle ahead, distance to the crown, your wipe count." },
        { name: "legal_moves", args: "", ret: "[move, …], ply", desc: "Your options from here: rush:ahead (big, risky), time:swing (safe medium), safe:edge (small, clean)." },
        { name: "make_move", args: "move, expected_ply", ret: "new state | error", desc: "Commit a move. Rushing gains ground fast but a hammer can ragdoll you back; timing the swing is safe unless it's mistimed." },
        { name: "resign", args: "", ret: "forfeit", desc: "Step off the course." },
      ],
      vocab: "rush:ahead · time:swing · safe:edge",
    },
    build, draw,
  };
})();
