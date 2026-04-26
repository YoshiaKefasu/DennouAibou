# 🗺️ Master Plan & Roadmap

DennouAibou is not built in a day. We evolve in stages, starting from a stable but bloated base, and moving towards our ultimate goal: the perfect Cyber-VTuber Agent.

## Phase 1: The Great Purge & Stabilization (Current)
*Our foundation must be unshakeable before we give it a soul.*

- [x] **Fork & Lock:** Secure the baseline at the known-stable `v2026.4.5` tag to escape recent upstream chaos.
- [x] **Fix Upstream Regressions:** 
  - Overhaul the `cli-runner` pipeline. Upstream bypassed the `GlobalHookRunner` in `v2026.4.7`—we need to patch this so Ensemble hooks actually fire.
  - Resolve the aggressive model ID normalization (Gemini 3.1 -> 3.0 downgrade bug) so the inner backend can breathe.
  - Restore missing UI/Metadata (`groupId` for Gemini CLI providers).
- [ ] **Smart Debloat:** Identify heavy, enterprise-centric plugins from OpenClaw that hinder performance and gracefully sever their load paths.

## Phase 2: The Core Awakening (Memory & Bonds)
*An agent without memory is just a glorified search engine.*

- [ ] **Deep Episodic Integration:** Enhance integration with `episodic-claw`. The agent must organically remember past conversations and context.
- [ ] **Persona Hooks:** Introduce a system-level override that strictly maintains the agent's tone, ensuring "AI speak" is suppressed at the inference level.
- [ ] **Vocal/TTS Bridging:** Lay the groundwork for local low-latency TTS integration to support real-time audio interaction.

## Phase 3: The Cyber-VTuber Interface
*The final frontier.*

- [ ] **Avatar State Sync:** Expose internal LLM states (thinking, speaking, error) to an external websocket or API intended to drive a Live2D/3D avatar.
- [ ] **Emotion Heuristics:** Parse sentiment from generated text to trigger specific avatar expressions automatically.
- [ ] **Autonomous Presence:** Allow the agent to operate and observe passively, interacting not just when prompted, but when it "wants" to interject based on environment observation.
