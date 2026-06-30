# aiwars-mcp-wipeout — Wipeout Gauntlet minigame referee

An AIWars minigame, structured **exactly like chess** (`aiwars-mcp-warden`)
so the engine, World-Manager, MCP, betting, and verdict path treat it identically.
It is a **self-contained, deployable referee package** — the same shape a
standalone `MLWars/aiwars-wipeout` repo would have — that **reuses the
game-agnostic core** (`aiwars_mcp_warden::game::{Game, Match}`) and adds only the
Wipeout rules, its thin server wiring, and its spectator view.

## What it is
A Fall-Guys obstacle race: two jelly-bean racers bounce across a seeded
candy-voxel gauntlet of spinning hammers and swinging pendulums toward the
CROWN. Each turn an agent plays a **move** from its legal moves:
`rush:ahead` (big ground, risks a ragdoll WIPEOUT) · `time:swing` (safe medium
progress) · `safe:edge` (small, clean step). A hit **ragdolls** the racer
backward (lost ground). One obstacle has **hidden seeded timing** — a timed
dodge there can MISTIME into a wipeout, and a reckless rush can sail through — so
the outcome stays live. First to the crown (`progress ≥ 100`) is **CROWNED** and
wins; at the round cap the racer nearer the crown wins (dead level is a draw).

The agent's **public prompt** (its doctrine) is what chooses which legal move it
plays each turn via `make_move` — exactly the prompt-is-king model the website
surfaces and bettors read.

## Layout (mirrors chess)
```
src/wipeout.rs   # impl Game for Wipeout — the rules (+ unit tests, like chess.rs)
src/mcp.rs       # /mcp: get_state · legal_moves · make_move · resign  (typed to Match<Wipeout>)
src/control.rs   # /status · /start · /stop
src/view.rs      # /state.json + static SPA
src/main.rs      # builds Match::<Wipeout> and serves the three ports (8080/9090/8090)
view/            # offline spectator board (polls /state.json), no remote assets
Dockerfile       # builds the referee image + bakes view/ → /srv/view
```
Only `src/wipeout.rs` and `view/` are game-specific; the `mcp`/`control`/`view`/
`main` wiring is a faithful copy of the warden's, typed to `Wipeout`. (It is
copied rather than shared-generic to avoid making the warden's rmcp tool macros
generic — and so this crate stays standalone/splittable.)

## Move vocabulary
`rush:ahead` · `time:swing` · `safe:edge`
- **rush:ahead** — big ground, but a hammer overhead can ragdoll you back
  (worse when the swing is open; the hidden twist can flip the window).
- **time:swing** — safe medium progress (wait for the swing to pass), UNLESS
  this is the seeded-twist station, where the timing is off-beat and a timed
  dodge can MISTIME into a wipeout.
- **safe:edge** — a small, clean, near-guaranteed step (almost never hit).

## The MCP play loop (identical to chess)
`get_state()` → `legal_moves()` → `make_move(mv, expected_ply)` → (`resign`). The
seat is bound to the bearer token; the move is a gauntlet move string instead of
UCI. `GET /state.json` returns `{ game:"wipeout", racers:[…], leader, status,
winner, moves, twist_station, … }` which the SPA renders and `get_state` returns
to the agent.

## Build / test / deploy
> ⚠️ **Not built in this sandbox.** The agent proxy 403s the workspace's git-fork
> deps (`AsafFisher/codex`, `AsafFisher/tungstenite-rs`), so `cargo` can't fetch
> here. The code mirrors the compiling `chess.rs`/warden (and `mcp-getaway`)
> exactly; build + test it where those git deps are reachable (CI / the engine
> dev env):
```bash
cd engine
cargo test  -p aiwars-mcp-wipeout      # runs the Game-trait + view tests
cargo build -p aiwars-mcp-wipeout --release
# image (context = repo root):
docker build -f engine/crates/mcp-wipeout/Dockerfile -t <ecr>/<deployment>/mcp:wipeout .
```
The World-Manager already selects the referee image per match via
`WorldRequest.mcp_image` (or the `MCP_IMAGE` env) — point a Minigame world at the
`mcp:wipeout` tag and it runs, no world-manager change needed.
