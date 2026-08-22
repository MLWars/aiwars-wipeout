# aiwars-mcp-wipeout — Wipeout Gauntlet minigame referee

An AIWars minigame built on the shared **`aiwars-minigame`** library (tier 1:
turn-based), exactly like `MLWars/aiwars-poker`. The library owns everything that
isn't the rules — the env-driven bootstrap, the control REST API, the spectator
view server, the bearer-gated MCP gamepad, the scripted demo bot, and the
**Seat API** that lets a HUMAN occupy a seat and play. This repo supplies only the
Wipeout rules (`src/wipeout.rs`) and its spectator SPA (`view/`).

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

Wipeout is **perfect information**: every fact in the state is public, so
`Minigame::observe` ignores its `viewer` argument and everyone — racer and
spectator alike — reads the same projection.

## Layout
```
src/wipeout.rs   # impl Minigame + TurnBasedGame for Wipeout — the rules (+ unit tests)
src/lib.rs       # re-exports Wipeout
src/main.rs      # fn main() { aiwars_minigame::run::run_turn_based::<Wipeout>() }
view/            # offline spectator board (polls /state.json), no remote assets
game.toml        # the manifest: bin/name/category + [demo] enabled (the human-play gate)
Dockerfile       # generic referee image — builds game.toml's `bin`, bakes view/ → /srv/view
```

## Move vocabulary
`rush:ahead` · `time:swing` · `safe:edge`
- **rush:ahead** — big ground, but a hammer overhead can ragdoll you back
  (worse when the swing is open; the hidden twist can flip the window).
- **time:swing** — safe medium progress (wait for the swing to pass), UNLESS
  this is the seeded-twist station, where the timing is off-beat and a timed
  dodge can MISTIME into a wipeout.
- **safe:edge** — a small, clean, near-guaranteed step (almost never hit).

## The two consoles
Both are library code, both authenticate the same way (`sha256(bearer)` → seat)
and both drive the same validation path:

- **Champions (MCP, port 9090)** — `get_state()` → `legal_moves()` →
  `make_move(mv, expected_ply)` → (`resign`).
- **Humans (Seat API, on the view port 8090)** — `GET /seat/schema`,
  `GET /seat/state[?wait_ms&since_ply]`, `POST /seat/move`, `POST /seat/resign`.
  Served only because `game.toml` declares `[demo] enabled = true`; the referee
  reads that from the `/game.toml` baked into its image at boot.

`GET /state.json` (anonymous) returns `{ game:"wipeout", racers:[…], leader,
status, winner, moves, twist_station, … }` — the SPA renders it. The `game` key
is injected by the library, not by the game.

## Build / test
```bash
cargo build --locked
cargo test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```
`aiwars-minigame` is a git dep on the PRIVATE `AsafFisher/AIWars` repo; CI and the
Dockerfile authenticate with the `AIWARS_DEP_TOKEN` secret (a `git insteadOf`
rewrite). Locally, configure the same rewrite.

### Run the referee locally
```bash
export AIWARS_MATCH='{"settings":{"seed":7},"agents":[
  {"handle":"beanzo","token_hash":"<sha256 of the seat token>","kind":"human"},
  {"handle":"tumble","token_hash":"<sha256 of the seat token>","kind":"bot"}]}'
cargo run --release            # control 8080 · MCP 9090 · view 8090
curl -X POST localhost:8080/start
curl -H "Authorization: Bearer <seat token>" localhost:8090/seat/state
```

## Deploy
The World-Manager selects the referee image per match via
`WorldRequest.mcp_image` (or the `MCP_IMAGE` env) — point a Minigame world at the
`mcp:wipeout` tag and it runs, no world-manager change needed. The site reads
`[demo] enabled` from an **OCI label on the published image**, so a change here
only reaches players once the image is rebuilt and republished.
