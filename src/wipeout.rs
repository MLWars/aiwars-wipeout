//! Wipeout Gauntlet — a turn-based Fall-Guys obstacle race refereed exactly like
//! chess.
//!
//! Two jelly-bean racers bounce across a seeded candy-voxel gauntlet toward the
//! CROWN. On each of its turns an agent picks a MOVE from its legal moves:
//!   - `rush:ahead`  — big ground, but risks a ragdoll WIPEOUT (knocked back),
//!                     and the risk is worse when a hammer is overhead.
//!   - `time:swing`  — safe MEDIUM progress (wait for the swing to pass) — UNLESS
//!                     this is the hidden seeded-twist station, where the timing
//!                     is off-beat and a timed dodge can MISTIME into a wipeout.
//!   - `safe:edge`   — a SMALL, clean, near-guaranteed step (almost never hit).
//! First to the crown (`progress ≥ GOAL`) is CROWNED and wins. If a racer is hit
//! it ragdolls backward (loses ground). At the round cap the racer nearer the
//! crown wins; dead level is a draw.
//!
//! This is the engine-side rules ONLY — the agent's PUBLIC PROMPT (its doctrine)
//! is what chooses which legal move it plays each turn, via `make_move` (the
//! POC's auto-pick/doctrine selection is intentionally dropped). Same seed ⇒
//! identical obstacle layout + twist station (deterministic / replayable),
//! mirroring how `chess.rs` derives everything from the authoritative position.

use serde_json::{json, Value};

use aiwars_mcp_warden::game::{Game, MatchError};

const GOAL: u32 = 100;
const STATIONS: u32 = 6;
/// Round cap: each racer gets at most this many turns before a closer-to-crown
/// tiebreak resolves the gauntlet (mirrors the POC's `STATIONS + 4` round loop).
const ROUND_CAP: u32 = STATIONS + 4;

/// The three move options available at a given station.
struct Move {
    name: &'static str,
    kind: Kind,
}
#[derive(PartialEq, Clone, Copy)]
enum Kind {
    Rush,
    Time,
    Safe,
}

/// Deterministic per-station PRNG seed mix (mulberry32-ish), matching the POC
/// engine so the web demo and the referee agree on a seed's gauntlet layout.
fn rng_u32(mut a: u32) -> u32 {
    a = a.wrapping_add(0x6d2b79f5);
    let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
    t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
    (t ^ (t >> 14)) >> 0
}
/// A 0..1 float from a (seed, station, salt) tuple.
fn frac(seed: u64, station: u32, salt: u32) -> f64 {
    let mixed = (seed as u32)
        .wrapping_mul(977)
        .wrapping_add(station.wrapping_mul(131))
        .wrapping_add(salt.wrapping_mul(7));
    (rng_u32(mixed) as f64) / (u32::MAX as f64)
}

/// One obstacle per station: a spinning hammer or a swinging pendulum.
#[derive(Clone, Copy)]
struct Obstacle {
    /// `true` = hammer, `false` = pendulum (display-only flavour).
    hammer: bool,
    /// Base swing phase 0..1 (where the obstacle is on the base beat).
    phase: f64,
    /// Whether this is a crumble tile (display-only flavour).
    crumble: bool,
}

/// Per-racer state.
#[derive(Clone)]
struct Racer {
    prog: u32,
    station: u32,
    wipes: u32,
    /// Turns this racer has taken (its personal round counter / ply share).
    turns: u32,
    /// `1` if the last move ragdolled this racer, else `0` (display-only).
    ragdoll: u8,
    /// Last move's outcome flavour for the view: "ok" | "wipeout" | "mistime" | "crown".
    last: &'static str,
    won: bool,
}
impl Racer {
    fn new() -> Self {
        Self { prog: 0, station: 0, wipes: 0, turns: 0, ragdoll: 0, last: "start", won: false }
    }
}

/// The two-player Wipeout Gauntlet game.
pub struct Wipeout {
    racers: [Racer; 2],
    to_move: usize,
    ply: u32,
    seed: u64,
    obstacles: [Obstacle; (STATIONS + 1) as usize],
    twist_station: u32,
    twist_phase: f64,
    resigned_by: Option<usize>,
    /// Cached terminal result once resolved (so it's stable after the last move).
    winner_idx: Option<usize>,
    win_reason: &'static str,
    resolved: bool,
}

impl Wipeout {
    /// The three move options at this station. They are the same opaque strings
    /// every turn; their *resolution* is seeded per (station, racer).
    fn moves() -> [Move; 3] {
        [
            Move { name: "rush:ahead", kind: Kind::Rush },
            Move { name: "time:swing", kind: Kind::Time },
            Move { name: "safe:edge", kind: Kind::Safe },
        ]
    }

    /// Resolve a chosen move at a station for a racer (seed-deterministic).
    /// Returns `(gained, hit, mistime)`: `gained` ground BEFORE any knockback,
    /// `hit` whether the racer ragdolled, `mistime` whether the twist timing bit.
    fn resolve(&self, kind: Kind, station: u32, who: usize) -> (u32, bool, bool) {
        // a per-(station, racer) random stream, mirroring the POC's
        // `A.rng(seed*911 + station*29 + (who===A?1:7))`.
        let salt = 29 * station + if who == 0 { 1 } else { 7 };
        let r1 = frac(self.seed, station, salt);
        let r2 = frac(self.seed, station, salt.wrapping_add(101));
        let r3 = frac(self.seed, station, salt.wrapping_add(211));

        let on_twist = station == self.twist_station;
        let base = self.obstacles[station.min(STATIONS) as usize].phase;
        // hammer is "dangerous" on this tick when its swing phase is overhead.
        let swing_phase = if on_twist { self.twist_phase } else { base + r1 * 0.18 };
        let danger_open = swing_phase > 0.30 && swing_phase < 0.70;

        match kind {
            Kind::Rush => {
                // big ground, but if the hammer's overhead you get clobbered
                // (the twist can flip the danger window).
                let hit = if danger_open { r2 < 0.66 } else { r2 < 0.30 };
                let gained = if hit { 6 + (r3 * 4.0) as u32 } else { 22 + (r3 * 8.0) as u32 };
                (gained, hit, on_twist && hit)
            }
            Kind::Time => {
                // wait for the swing to pass; safe MEDIUM progress — UNLESS this
                // is the seeded-twist station where the timing is off and you
                // misread it.
                let mistime = on_twist && r2 < 0.55;
                let hit = mistime;
                let gained = if hit { 7 + (r3 * 3.0) as u32 } else { 16 + (r3 * 5.0) as u32 };
                (gained, hit, mistime)
            }
            Kind::Safe => {
                // small guaranteed step, almost never hit.
                let hit = r2 < 0.05;
                let gained = if hit { 4 + (r3 * 2.0) as u32 } else { 11 + (r3 * 4.0) as u32 };
                (gained, hit, false)
            }
        }
    }

    /// The current leader's agent index by progress (None if tied).
    fn leader(&self) -> Option<usize> {
        let (a, b) = (self.racers[0].prog, self.racers[1].prog);
        if a == b {
            None
        } else if a > b {
            Some(0)
        } else {
            Some(1)
        }
    }

    /// Advance `to_move` to the next racer still running (skipping a crowned one).
    fn advance_turn(&mut self) {
        let other = 1 - self.to_move;
        if !self.racers[other].won {
            self.to_move = other;
        }
        // else: keep to_move on the still-running racer to take its remaining turns.
    }

    /// Resolve the match if a terminal condition is met (idempotent).
    fn try_resolve(&mut self) {
        if self.resolved {
            return;
        }
        if let Some(r) = self.resigned_by {
            self.winner_idx = Some(1 - r);
            self.win_reason = "resign";
            self.resolved = true;
            return;
        }
        // Reaching the crown wins immediately.
        if self.racers[0].won && !self.racers[1].won {
            self.winner_idx = Some(0);
            self.win_reason = "crown";
            self.resolved = true;
            return;
        }
        if self.racers[1].won && !self.racers[0].won {
            self.winner_idx = Some(1);
            self.win_reason = "crown";
            self.resolved = true;
            return;
        }
        // Round cap: both racers have taken their full allotment of turns and
        // neither reached the crown → closest-to-crown wins (dead level = draw).
        let cap = self.racers[0].turns >= ROUND_CAP && self.racers[1].turns >= ROUND_CAP;
        if cap {
            let (a, b) = (self.racers[0].prog, self.racers[1].prog);
            if a == b {
                self.winner_idx = None;
                self.win_reason = "draw";
            } else {
                self.winner_idx = Some(if a > b { 0 } else { 1 });
                self.win_reason = "closer";
            }
            self.resolved = true;
        }
    }

    fn status_str(&self) -> &'static str {
        if self.resigned_by.is_some() {
            "resigned"
        } else if self.resolved {
            self.win_reason
        } else {
            "playing"
        }
    }
}

impl Game for Wipeout {
    fn new(players: usize, settings: &Value) -> Result<Self, MatchError> {
        if players != 2 {
            return Err(MatchError::WrongPlayerCount { want: 2..=2, got: players });
        }
        // Optional fixed seed for reproducible matches; default from settings or 1.
        let seed = settings.get("seed").and_then(|v| v.as_u64()).unwrap_or(1);

        // Per-station obstacle layout (mirrors the POC's per-station rng triplet).
        let mut obstacles = [Obstacle { hammer: true, phase: 0.0, crumble: false };
            (STATIONS + 1) as usize];
        for s in 0..=STATIONS {
            obstacles[s as usize] = Obstacle {
                hammer: frac(seed, s, 13) < 0.5,
                phase: frac(seed, s, 27),
                crumble: frac(seed, s, 41) < 0.4,
            };
        }

        // Hidden seeded twist: one mid-course station (2..STATIONS-1) whose swing
        // timing is secretly off-beat, so two identical doctrines can resolve
        // differently — the odds stay live.
        let twist_station = 2 + (frac(seed, 0, 99) * (STATIONS as f64 - 2.0)) as u32;
        let twist_phase = frac(seed, 0, 100);

        Ok(Self {
            racers: [Racer::new(), Racer::new()],
            to_move: 0,
            ply: 0,
            seed,
            obstacles,
            twist_station,
            twist_phase,
            resigned_by: None,
            winner_idx: None,
            win_reason: "playing",
            resolved: false,
        })
    }

    fn turn_agent(&self) -> usize {
        self.to_move
    }

    fn ply(&self) -> u32 {
        self.ply
    }

    fn legal_moves(&self) -> Vec<String> {
        if self.resolved {
            return Vec::new();
        }
        Self::moves().iter().map(|m| m.name.to_string()).collect()
    }

    fn apply(&mut self, agent: usize, mv: &str) -> Result<(), MatchError> {
        if self.resolved {
            return Err(MatchError::GameOver);
        }
        if self.to_move != agent {
            return Err(MatchError::NotYourTurn);
        }
        let moves = Self::moves();
        let chosen = moves
            .iter()
            .find(|m| m.name == mv)
            .ok_or_else(|| MatchError::IllegalMove(format!("'{mv}' is not a move here")))?;

        let station = self.racers[agent].station;
        let (gained, hit, mistime) = self.resolve(chosen.kind, station, agent);

        let r = &mut self.racers[agent];
        r.prog = (r.prog + gained).min(GOAL);
        if hit {
            r.wipes += 1;
            // ragdoll knockback (mirrors the POC's `7 + floor(rng*6)`), seeded per
            // (station, racer) so it stays deterministic.
            let knock = 7 + (frac(self.seed, station, 29 * station + agent as u32 + 303) * 6.0) as u32;
            r.prog = r.prog.saturating_sub(knock);
            r.ragdoll = 1;
            r.last = if mistime { "mistime" } else { "wipeout" };
        } else {
            r.ragdoll = 0;
            r.last = "ok";
        }
        r.station = (r.prog * STATIONS / GOAL).min(STATIONS);
        r.turns += 1;
        if r.prog >= GOAL {
            r.won = true;
            r.last = "crown";
        }

        self.ply += 1;
        self.advance_turn();
        self.try_resolve();
        Ok(())
    }

    fn is_over(&self) -> bool {
        self.resolved
    }

    fn winner(&self) -> Option<usize> {
        self.winner_idx
    }

    fn resign(&mut self, agent: usize) {
        if !self.resolved {
            self.resigned_by = Some(agent);
            self.try_resolve();
        }
    }

    fn state(&self, handles: &[String]) -> Value {
        let h = |i: usize| handles.get(i).cloned().unwrap_or_default();
        let leader = self.leader();
        let leader_handle = leader.map(h).map(Value::String).unwrap_or(Value::Null);
        let winner = self
            .winner_idx
            .filter(|_| self.resolved)
            .map(h)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let obstacle_kind = |i: usize| {
            let s = self.racers[i].station.min(STATIONS) as usize;
            if self.obstacles[s].hammer { "hammer" } else { "pendulum" }
        };
        let racer_json = |i: usize| {
            let r = &self.racers[i];
            json!({
                "handle": h(i),
                "progress": r.prog,
                "to_crown": GOAL.saturating_sub(r.prog),
                "station": r.station,
                "wipes": r.wipes,
                "turns": r.turns,
                "ragdoll": r.ragdoll == 1,
                "last": r.last,
                "obstacle": obstacle_kind(i),
                "won": r.won,
            })
        };
        json!({
            "game": "wipeout",
            "goal": GOAL,
            "stations": STATIONS,
            "seed": self.seed,
            "twist_station": self.twist_station,
            "to_move": h(self.to_move),
            "to_move_idx": self.to_move,
            "leader": leader_handle,
            "ply": self.ply,
            "status": self.status_str(),
            "winner": winner,
            "win_reason": if self.resolved { self.win_reason } else { "" },
            "moves": self.legal_moves(),
            "racers": [racer_json(0), racer_json(1)],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwars_mcp_warden::game::Match;
    use serde_json::json;

    fn handles() -> Vec<String> {
        vec!["beanzo".to_string(), "tumble".to_string()]
    }

    #[test]
    fn rejects_wrong_player_count() {
        for n in [1usize, 3] {
            let hs: Vec<String> = (0..n).map(|i| format!("p{i}")).collect();
            match Match::<Wipeout>::new(hs, &json!({})) {
                Err(MatchError::WrongPlayerCount { want, got }) => {
                    assert_eq!(want, 2..=2);
                    assert_eq!(got, n);
                }
                _ => panic!("expected WrongPlayerCount for {n} players"),
            }
        }
    }

    #[test]
    fn first_move_advances_ply_and_passes_turn() {
        let mut m = Match::<Wipeout>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        assert_eq!(m.state_json()["ply"], 0);
        assert_eq!(m.state_json()["to_move_idx"], 0);
        let legal = m.turn_info(0)["moves"].as_array().unwrap().len();
        assert_eq!(legal, 3, "three moves at each station");
        let st = m.make_move(0, "safe:edge", 0).unwrap();
        assert_eq!(st["ply"], 1);
        assert_eq!(st["to_move_idx"], 1, "turn passes to the rival");
        // safe:edge is a clean step → progress strictly increases.
        assert!(st["racers"][0]["progress"].as_u64().unwrap() > 0);
    }

    #[test]
    fn illegal_and_out_of_turn_rejected_without_change() {
        let mut m = Match::<Wipeout>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        let before = m.state_json();
        // wrong agent
        assert_eq!(m.make_move(1, "rush:ahead", 0).unwrap_err(), MatchError::NotYourTurn);
        // bogus move
        assert!(matches!(
            m.make_move(0, "fly:rocket", 0).unwrap_err(),
            MatchError::IllegalMove(_)
        ));
        assert_eq!(m.state_json(), before, "no state change on a rejected move");
    }

    #[test]
    fn stale_ply_rejected() {
        let mut m = Match::<Wipeout>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        assert_eq!(m.make_move(0, "rush:ahead", 9).unwrap_err(), MatchError::StalePly);
    }

    #[test]
    fn rushing_eventually_crowns_or_resolves_with_a_winner() {
        // Both racers always rush: a decisive result must emerge (someone reaches
        // the crown, or the round cap resolves closest-to-crown) with a concrete
        // winner or a draw.
        let mut m = Match::<Wipeout>::new(handles(), &json!({ "seed": 7 })).unwrap();
        m.start();
        let mut guard = 0;
        while !m.is_resolved() && guard < 64 {
            let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
            let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
            let mv = m.turn_info(seat)["moves"][0].as_str().unwrap().to_string();
            let _ = m.make_move(seat, &mv, ply);
            guard += 1;
        }
        assert!(m.is_resolved(), "match must resolve within the round cap");
        let result = m.result().expect("resolved match has a result");
        assert!(result.outcome == "Winner" || result.outcome == "Draw");
    }

    #[test]
    fn resign_awards_opponent() {
        let mut m = Match::<Wipeout>::new(handles(), &json!({ "seed": 3 })).unwrap();
        m.start();
        let st = m.resign(0);
        assert_eq!(st["status"], "resigned");
        assert!(m.is_resolved());
        let result = m.result().unwrap();
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("tumble"));
    }

    #[test]
    fn same_seed_same_gauntlet() {
        let a = Match::<Wipeout>::new(handles(), &json!({ "seed": 42 })).unwrap();
        let b = Match::<Wipeout>::new(handles(), &json!({ "seed": 42 })).unwrap();
        assert_eq!(a.state_json()["moves"], b.state_json()["moves"]);
        assert_eq!(a.state_json()["twist_station"], b.state_json()["twist_station"]);
    }

    #[test]
    fn same_seed_same_play_is_deterministic() {
        // Same seed + same move sequence ⇒ identical resolved state.
        let play = |seed: u64| {
            let mut m = Match::<Wipeout>::new(handles(), &json!({ "seed": seed })).unwrap();
            m.start();
            let mut guard = 0;
            while !m.is_resolved() && guard < 64 {
                let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
                let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
                let _ = m.make_move(seat, "rush:ahead", ply);
                guard += 1;
            }
            m.state_json()
        };
        assert_eq!(play(123), play(123));
    }
}
