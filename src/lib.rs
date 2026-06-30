//! `aiwars-mcp-wipeout` — the **referee** for the Wipeout Gauntlet minigame.
//!
//! Structured exactly like `aiwars-mcp-warden` (chess): it reuses the
//! game-agnostic core from that crate — the [`aiwars_mcp_warden::game::Game`]
//! trait and [`aiwars_mcp_warden::game::Match`] lifecycle wrapper — and adds:
//!
//! - [`wipeout`] — the concrete [`wipeout::Wipeout`] `Game` impl (the rules).
//! - [`mcp`] — the per-agent MCP server (`/mcp`, bearer-gated): the same four
//!   tools (`get_state`, `legal_moves`, `make_move`, `resign`), here typed to a
//!   `Match<Wipeout>`.
//! - [`control`] — the control REST API (`/status`, `/start`, `/stop`).
//! - [`view`] — the read-only spectator HTTP server (`/state.json` + static SPA).
//!
//! The thin server wiring is a faithful copy of the warden's (typed to
//! `Wipeout` instead of `Chess`) so this stays a self-contained, deployable
//! game package — the same shape a standalone `MLWars/aiwars-wipeout` repo has.

pub mod control;
pub mod mcp;
pub mod view;
pub mod wipeout;
