//! Wipeout Gauntlet — a turn-based Fall-Guys obstacle race, refereed on the shared
//! `aiwars-minigame` library (tier 1: `Minigame` + `TurnBasedGame`).
//!
//! Two jelly-bean racers bounce across a seeded candy-voxel gauntlet toward the
//! CROWN. On each of its turns an agent picks a MOVE from its legal moves:
//!
//! - `rush:ahead` — big ground, but risks a ragdoll WIPEOUT (knocked back), and the risk is
//!   worse when a hammer is overhead.
//! - `time:swing` — safe MEDIUM progress (wait for the swing to pass) — UNLESS this is the
//!   hidden seeded-twist station, where the timing is off-beat and a timed dodge can MISTIME
//!   into a wipeout.
//! - `safe:edge` — a SMALL, clean, near-guaranteed step (almost never hit).
//!
//! First to the crown (`progress ≥ GOAL`) is CROWNED and wins. If a racer is hit
//! it ragdolls backward (loses ground). At the round cap the racer nearer the
//! crown wins; dead level is a draw.
//!
//! This is the engine-side rules ONLY — the agent's PUBLIC PROMPT (its doctrine)
//! is what chooses which legal move it plays each turn, via `make_move` (the
//! POC's auto-pick/doctrine selection is intentionally dropped). Same seed ⇒
//! identical obstacle layout + twist station (deterministic / replayable).
//!
//! Wipeout is **perfect information**: there is nothing a racer knows that the
//! spectator does not, so [`Minigame::observe`] ignores its `viewer` argument and
//! returns the one public projection to everyone.

use serde_json::{json, Value};

use aiwars_minigame::{AgentId, MatchError, Minigame, Outcome, TurnBasedGame};

const GOAL: u32 = 100;
const STATIONS: u32 = 6;
/// Round cap: each racer gets at most this many turns before a closer-to-crown
/// tiebreak resolves the gauntlet (mirrors the POC's `STATIONS + 4` round loop).
const ROUND_CAP: u32 = STATIONS + 4;
/// Exactly two racers run a gauntlet.
const PLAYERS: usize = 2;

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
    t ^ (t >> 14)
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
    /// Whether this is a crumble tile (display-only flavour, surfaced in the projection).
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
        Self {
            prog: 0,
            station: 0,
            wipes: 0,
            turns: 0,
            ragdoll: 0,
            last: "start",
            won: false,
        }
    }
}

/// The two-player Wipeout Gauntlet game.
pub struct Wipeout {
    /// The racers by IDENTITY, in seat order. The library bridges an auth-resolved seat to
    /// its `AgentId` before calling us, so the game never handles seat indices from outside.
    players: Vec<AgentId>,
    racers: [Racer; PLAYERS],
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
            Move {
                name: "rush:ahead",
                kind: Kind::Rush,
            },
            Move {
                name: "time:swing",
                kind: Kind::Time,
            },
            Move {
                name: "safe:edge",
                kind: Kind::Safe,
            },
        ]
    }

    /// The seat holding `agent`, or `None` for an id that never sat down.
    fn seat_of(&self, agent: &AgentId) -> Option<usize> {
        self.players.iter().position(|p| p == agent)
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
        let swing_phase = if on_twist {
            self.twist_phase
        } else {
            base + r1 * 0.18
        };
        let danger_open = swing_phase > 0.30 && swing_phase < 0.70;

        match kind {
            Kind::Rush => {
                // big ground, but if the hammer's overhead you get clobbered
                // (the twist can flip the danger window).
                let hit = if danger_open { r2 < 0.66 } else { r2 < 0.30 };
                let gained = if hit {
                    6 + (r3 * 4.0) as u32
                } else {
                    22 + (r3 * 8.0) as u32
                };
                (gained, hit, on_twist && hit)
            }
            Kind::Time => {
                // wait for the swing to pass; safe MEDIUM progress — UNLESS this
                // is the seeded-twist station where the timing is off and you
                // misread it.
                let mistime = on_twist && r2 < 0.55;
                let hit = mistime;
                let gained = if hit {
                    7 + (r3 * 3.0) as u32
                } else {
                    16 + (r3 * 5.0) as u32
                };
                (gained, hit, mistime)
            }
            Kind::Safe => {
                // small guaranteed step, almost never hit.
                let hit = r2 < 0.05;
                let gained = if hit {
                    4 + (r3 * 2.0) as u32
                } else {
                    11 + (r3 * 4.0) as u32
                };
                (gained, hit, false)
            }
        }
    }

    /// The current leader's seat by progress (None if tied).
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

impl Minigame for Wipeout {
    fn new(agents: &[AgentId], settings: &Value) -> Result<Self, MatchError> {
        if agents.len() != PLAYERS {
            return Err(MatchError::WrongPlayerCount {
                want: 2..=2,
                got: agents.len(),
            });
        }
        // Optional fixed seed for reproducible matches; default from settings or 1.
        let seed = settings.get("seed").and_then(|v| v.as_u64()).unwrap_or(1);

        // Per-station obstacle layout (mirrors the POC's per-station rng triplet).
        let mut obstacles = [Obstacle {
            hammer: true,
            phase: 0.0,
            crumble: false,
        }; (STATIONS + 1) as usize];
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
            players: agents.to_vec(),
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

    fn name(&self) -> &'static str {
        "wipeout"
    }

    fn instructions(&self) -> String {
        "AIWars Wipeout Gauntlet. Two jelly-bean racers bounce across a seeded candy-voxel \
         gauntlet of spinning hammers and swinging pendulums; the first to reach the CROWN \
         (progress 100) wins. Read the state each turn: `racers` (yours has your handle) \
         carries `progress`, `to_crown`, `station`, `wipes` and the `obstacle` ahead of you, \
         and `moves` lists your EXACT legal moves. Play with make_move, mv = one of: \
         \"rush:ahead\" — big ground, but a hammer overhead can ragdoll you BACKWARD; \
         \"time:swing\" — safe medium progress, unless you mistime the hidden twist station; \
         \"safe:edge\" — a small, clean step that is almost never hit. Pass expected_ply = the \
         ply you saw. If neither racer is crowned by the round cap, the one nearer the crown \
         wins (dead level is a draw). resign forfeits the gauntlet to your rival. Your seat is \
         your bearer token; you cannot act as your rival."
            .into()
    }

    /// Wipeout is PERFECT INFORMATION — a racer knows nothing a spectator doesn't — so
    /// `viewer` is deliberately ignored and everyone gets the same projection. (The library
    /// injects the `"game"` key, so it is not set here.)
    fn observe(&self, _viewer: Option<&AgentId>) -> Value {
        let h = |i: usize| self.players[i].0.clone();
        let leader_handle = self
            .leader()
            .map(h)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let winner = self
            .winner_idx
            .filter(|_| self.resolved)
            .map(h)
            .map(Value::String)
            .unwrap_or(Value::Null);
        let obstacle_at = |i: usize| -> &Obstacle {
            &self.obstacles[self.racers[i].station.min(STATIONS) as usize]
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
                "obstacle": if obstacle_at(i).hammer { "hammer" } else { "pendulum" },
                "crumble": obstacle_at(i).crumble,
                "won": r.won,
            })
        };
        json!({
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

    fn outcome(&self) -> Option<Outcome> {
        if !self.resolved {
            return None;
        }
        Some(match self.winner_idx {
            Some(i) => Outcome::Win(self.players[i].clone()),
            None => Outcome::Draw,
        })
    }

    /// The wall-clock timeout tiebreak: whoever is nearer the crown right now — the same rule
    /// the round cap uses. Dead level ⇒ `None` ⇒ a timeout draws.
    fn timeout_leader(&self) -> Option<AgentId> {
        self.leader().map(|i| self.players[i].clone())
    }
}

impl TurnBasedGame for Wipeout {
    fn turn_agent(&self) -> AgentId {
        self.players[self.to_move].clone()
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

    fn apply(&mut self, agent: &AgentId, mv: &str) -> Result<(), MatchError> {
        if self.resolved {
            return Err(MatchError::GameOver);
        }
        let seat = self
            .seat_of(agent)
            .ok_or_else(|| MatchError::Rejected("not a racer in this gauntlet".into()))?;
        // Defensive: `TurnBasedMatch` already polices turn order (`TurnError::NotYourTurn`)
        // and the ply, but keep the game honest if it is ever driven directly.
        if self.to_move != seat {
            return Err(MatchError::Rejected("not your turn".into()));
        }
        let moves = Self::moves();
        let chosen = moves
            .iter()
            .find(|m| m.name == mv)
            .ok_or_else(|| MatchError::Rejected(format!("'{mv}' is not a move here")))?;

        // --- committed, mutating path (validation has passed) ---
        let station = self.racers[seat].station;
        let (gained, hit, mistime) = self.resolve(chosen.kind, station, seat);

        let r = &mut self.racers[seat];
        r.prog = (r.prog + gained).min(GOAL);
        if hit {
            r.wipes += 1;
            // ragdoll knockback (mirrors the POC's `7 + floor(rng*6)`), seeded per
            // (station, racer) so it stays deterministic.
            let knock =
                7 + (frac(self.seed, station, 29 * station + seat as u32 + 303) * 6.0) as u32;
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

    fn resign(&mut self, agent: &AgentId) {
        if self.resolved {
            return;
        }
        if let Some(seat) = self.seat_of(agent) {
            self.resigned_by = Some(seat);
            self.try_resolve();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwars_minigame::{RefereeMatch, TurnBasedMatch, TurnError};
    use serde_json::json;

    fn racers() -> Vec<AgentId> {
        vec![AgentId("beanzo".into()), AgentId("tumble".into())]
    }

    /// A started two-seat match on a fixed seed.
    fn started(seed: u64) -> TurnBasedMatch {
        let mut m = TurnBasedMatch::new::<Wipeout>(racers(), &json!({ "seed": seed })).unwrap();
        m.start();
        m
    }

    #[test]
    fn rejects_wrong_player_count() {
        for n in [1usize, 3] {
            let ids: Vec<AgentId> = (0..n).map(|i| AgentId(format!("p{i}"))).collect();
            match Wipeout::new(&ids, &json!({})) {
                Err(MatchError::WrongPlayerCount { want, got }) => {
                    assert_eq!(want, 2..=2);
                    assert_eq!(got, n);
                }
                Err(e) => panic!("expected WrongPlayerCount for {n} players, got {e}"),
                Ok(_) => panic!("expected WrongPlayerCount for {n} players, got a built game"),
            }
        }
    }

    #[test]
    fn first_move_advances_ply_and_passes_turn() {
        let mut m = started(7);
        assert_eq!(m.state_json()["ply"], 0);
        assert_eq!(m.state_json()["to_move_idx"], 0);
        assert_eq!(
            m.turn_info(0)["moves"].as_array().unwrap().len(),
            3,
            "three moves at each station"
        );
        let st = m.make_move(0, "safe:edge", 0).unwrap();
        assert_eq!(st["ply"], 1);
        assert_eq!(st["to_move_idx"], 1, "turn passes to the rival");
        // safe:edge is a clean step → progress strictly increases.
        assert!(st["racers"][0]["progress"].as_u64().unwrap() > 0);
    }

    /// The library injects the `game` key the spectator SPA dispatches on — the game itself
    /// must not (and no longer does) set it.
    #[test]
    fn public_state_carries_the_library_injected_game_key() {
        let m = started(7);
        assert_eq!(m.state_json()["game"], "wipeout");
        assert!(
            !Wipeout::new(&racers(), &json!({}))
                .unwrap()
                .observe(None)
                .as_object()
                .unwrap()
                .contains_key("game"),
            "the game must not set `game` itself — the library owns that key"
        );
    }

    /// The turn-order policing this port handed to the library: a move by the WRONG agent is
    /// refused with `TurnError::NotYourTurn`, and nothing changes.
    #[test]
    fn move_by_the_wrong_agent_is_refused() {
        let mut m = started(7);
        let before = m.state_json();
        assert_eq!(
            m.make_move(1, "rush:ahead", 0).unwrap_err(),
            TurnError::NotYourTurn
        );
        assert_eq!(
            m.state_json(),
            before,
            "no state change on an out-of-turn move"
        );
    }

    /// The game's OWN defensive check, driven directly (no match wrapper): an illegal mover is
    /// `Rejected` now that `MatchError::NotYourTurn` is gone.
    #[test]
    fn game_driven_directly_also_refuses_the_wrong_agent() {
        let mut g = Wipeout::new(&racers(), &json!({ "seed": 7 })).unwrap();
        assert!(matches!(
            g.apply(&AgentId("tumble".into()), "rush:ahead"),
            Err(MatchError::Rejected(_))
        ));
        assert!(matches!(
            g.apply(&AgentId("nobody".into()), "rush:ahead"),
            Err(MatchError::Rejected(_))
        ));
        assert_eq!(g.ply(), 0);
    }

    #[test]
    fn illegal_move_rejected_without_change() {
        let mut m = started(7);
        let before = m.state_json();
        match m.make_move(0, "fly:rocket", 0).unwrap_err() {
            TurnError::Core(MatchError::Rejected(msg)) => assert!(msg.contains("fly:rocket")),
            other => panic!("expected Rejected, got {other:?}"),
        }
        assert_eq!(m.state_json(), before, "no state change on a rejected move");
    }

    #[test]
    fn stale_ply_rejected() {
        let mut m = started(7);
        assert_eq!(
            m.make_move(0, "rush:ahead", 9).unwrap_err(),
            TurnError::StalePly
        );
    }

    /// Drive a whole gauntlet the way a client does: read `to_move_idx`/`ply`, play the first
    /// legal move. Every call must be ACCEPTED — a rejected move here would mean the seat/ply
    /// the public projection advertises does not match what the match will take, and
    /// swallowing it would let a game whose moves ALL fail still look "deterministic".
    fn play_out(m: &mut TurnBasedMatch) {
        let mut guard = 0;
        while !m.is_resolved() && guard < 64 {
            let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
            let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
            let mv = m.turn_info(seat)["moves"][0].as_str().unwrap().to_string();
            m.make_move(seat, &mv, ply)
                .unwrap_or_else(|e| panic!("seat {seat} playing {mv} at ply {ply}: {e}"));
            guard += 1;
        }
    }

    /// Seed 7 is fixed, so the whole gauntlet is fixed: assert the EXACT result, not merely
    /// that one exists. (`outcome` can only ever be "Winner" or "Draw", so asserting that
    /// disjunction proves nothing — it holds with the crown rule deleted.)
    #[test]
    fn rushing_all_the_way_crowns_the_racer_who_gets_there_first() {
        let mut m = started(7);
        play_out(&mut m);
        assert!(m.is_resolved(), "match must resolve within the round cap");
        let result = m.result().expect("resolved match has a result");
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("beanzo"));
        let st = m.state_json();
        assert_eq!(st["win_reason"], "crown", "the crown ends it, not the cap");
        assert_eq!(st["racers"][0]["won"], true);
        assert!(st["moves"].as_array().unwrap().is_empty());
    }

    /// The round cap's OWN rule, which the crown path above never reaches: with nobody
    /// crowned, the racer nearer the crown wins.
    #[test]
    fn at_the_round_cap_the_racer_nearer_the_crown_wins() {
        let mut g = Wipeout::new(&racers(), &json!({ "seed": 7 })).unwrap();
        g.racers[0].prog = 40;
        g.racers[0].turns = ROUND_CAP;
        g.racers[1].prog = 30;
        g.racers[1].turns = ROUND_CAP;
        g.try_resolve();
        assert_eq!(g.win_reason, "closer");
        assert_eq!(g.outcome(), Some(Outcome::Win(AgentId("beanzo".into()))));

        // Dead level at the cap is a draw — the same tie rule `timeout_leader` reports.
        let mut g = Wipeout::new(&racers(), &json!({ "seed": 7 })).unwrap();
        g.racers[0].prog = 30;
        g.racers[0].turns = ROUND_CAP;
        g.racers[1].prog = 30;
        g.racers[1].turns = ROUND_CAP;
        g.try_resolve();
        assert_eq!(g.win_reason, "draw");
        assert_eq!(g.outcome(), Some(Outcome::Draw));
        assert_eq!(g.timeout_leader(), None);
    }

    #[test]
    fn resign_awards_opponent() {
        let mut m = started(3);
        let st = m.resign(0);
        assert_eq!(st["status"], "resigned");
        assert!(m.is_resolved());
        let result = m.result().unwrap();
        assert_eq!(result.outcome, "Winner");
        assert_eq!(result.winner.as_deref(), Some("tumble"));
    }

    #[test]
    fn outcome_names_the_winner_by_identity() {
        let mut g = Wipeout::new(&racers(), &json!({ "seed": 3 })).unwrap();
        assert_eq!(g.outcome(), None);
        g.resign(&AgentId("beanzo".into()));
        assert_eq!(g.outcome(), Some(Outcome::Win(AgentId("tumble".into()))));
    }

    #[test]
    fn timeout_leader_is_whoever_is_nearer_the_crown() {
        let mut g = Wipeout::new(&racers(), &json!({ "seed": 7 })).unwrap();
        assert_eq!(g.timeout_leader(), None, "dead level at the start");
        g.apply(&AgentId("beanzo".into()), "safe:edge").unwrap();
        assert_eq!(g.timeout_leader(), Some(AgentId("beanzo".into())));
    }

    #[test]
    fn same_seed_same_gauntlet() {
        let a = started(42);
        let b = started(42);
        assert_eq!(a.state_json()["moves"], b.state_json()["moves"]);
        assert_eq!(
            a.state_json()["twist_station"],
            b.state_json()["twist_station"]
        );
    }

    #[test]
    fn same_seed_same_play_is_deterministic() {
        // Same seed + same move sequence ⇒ identical resolved state.
        let play = |seed: u64| {
            let mut m = started(seed);
            let mut guard = 0;
            while !m.is_resolved() && guard < 64 {
                let ply = m.state_json()["ply"].as_u64().unwrap() as u32;
                let seat = m.state_json()["to_move_idx"].as_u64().unwrap() as usize;
                m.make_move(seat, "rush:ahead", ply)
                    .unwrap_or_else(|e| panic!("seat {seat} rushing at ply {ply}: {e}"));
                guard += 1;
            }
            m.state_json()
        };
        assert_eq!(play(123), play(123));
    }

    /// The whole point of the port: the seat payload a HUMAN's browser console reads carries
    /// its turn info (`your_turn` + `moves`) alongside the private projection.
    #[test]
    fn seat_state_carries_turn_info_for_a_human_console() {
        let m = started(7);
        let s = m.seat_state(0);
        assert_eq!(s["you"]["handle"], "beanzo");
        assert_eq!(s["turn"]["your_turn"], true);
        assert_eq!(s["turn"]["moves"].as_array().unwrap().len(), 3);
        assert_eq!(s["state"]["to_move"], "beanzo");
        assert_eq!(m.seat_state(1)["turn"]["your_turn"], false);
    }

    /// The shipped game.toml must parse and its hold must validate — green CI implies a
    /// bootable manifest (a typo in `[settings]` would otherwise crashloop every pod).
    #[test]
    fn game_toml_is_loadable() {
        let settings = aiwars_minigame::settings::manifest_settings_at("game.toml").unwrap();
        aiwars_minigame::settings::validate_hold(&settings).unwrap();
    }
}
