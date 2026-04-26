# 🔬 Gemini Model-ID Normalization Bypass (Issue #65363)

**Branch:** `fix/gemini-cli-model-id-normalization`
**Target file:** `extensions/google/provider-models.ts`
**Upstream reference:** PR #65433 (cherry-pick essentials only — reject the NUL safety & Sonnet bloat)

---

## 1. The Context (The Threat)

OpenClaw implemented a "forward compatibility" layer for the Google provider. When a user selects a `gemini-3.1` model, the normalization layer intercepts the request and rewrites the model ID to a hardcoded legacy template string.

While this may prevent crashes for the REST API wrapper, **it completely destroys the `@google/gemini-cli` binary connection.**  
The CLI backend expects the raw, modern `3.1` ID string. By substituting a legacy `3.0-preview` template, OpenClaw causes a fatal "communication failure."

Upstream has an active PR for this (#65433), but it is a "kitchen sink" PR that bundles the Gemini fix with unrelated changes like "inbound NUL safety" and "Sonnet 4.6 context adjustments." We reject this bloat. DennouAibou will cherry-pick ONLY the model-ID mapping logic to keep our core lean.

---

## 2. The Root Cause (Exact Location Found)

**File:** `extensions/google/provider-models.ts`

The bug is in the CLI-facing template ID constants. They reference **outdated preview template IDs** instead of the modern 3.1 strings:

```typescript
// BEFORE (BROKEN) — Lines 17-19
const GEMINI_3_1_PRO_TEMPLATE_IDS   = ["gemini-3-pro-preview"] as const;   // ❌古い (3.0 preview)
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite-preview"] as const; // ✅ OK
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;  // ❌古い (3.0 preview)
```

**Why this kills CLI:**  
`resolveGoogleGeminiForwardCompatModel()` (L98–L167) looks up these constants under `cliTemplateIds`.  
When Gemini CLI receives `gemini-3-pro-preview` instead of `gemini-3.1-pro-preview`, the `@google/gemini-cli` binary rejects the model name with a communication error.

---

## 3. The Surgical Fix (DennouAibou Debloated Implementation)

**One target, two lines changed. Nothing else.**

### Step 1 — Fix the broken template ID constants

```diff
// extensions/google/provider-models.ts

- const GEMINI_3_1_PRO_TEMPLATE_IDS   = ["gemini-3-pro-preview"] as const;
+ const GEMINI_3_1_PRO_TEMPLATE_IDS   = ["gemini-3.1-pro-preview", "gemini-3-pro-preview"] as const;

  const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite-preview"] as const; // no change needed

- const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview"] as const;
+ const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3.1-flash-preview", "gemini-3-flash-preview"] as const;
```

**Strategy:** We insert the correct `3.1` ID as the **first entry** (primary) and keep the old `3.0-preview` string as a **fallback** in second position.  
This way, `cloneFirstTemplateModel()` (called at L153) picks the primary `3.1` ID first.  
If for any reason the 3.1 template is missing from a provider's catalog, it silently falls through to the legacy 3.0 string. Zero breakage risk.

### Step 2 — Verify the 2.5 → 3.1 CLI "upgrade" mapping logic

Confirm that `L108–L125` (the `GEMINI_2_5_*` families) point to the **corrected** 3.1 constants above as their `cliTemplateIds`.  
After Step 1, these will automatically resolve to the correct 3.1 string — no additional change needed.

### Step 3 — Commit

```
git add extensions/google/provider-models.ts
git commit -m "[FIX-UPSTREAM] Restore Gemini 3.1 CLI template IDs (fix #65363, cherry-pick from PR #65433 essentials)"
```

---

## 4. What We Are NOT Touching (Avoiding Bloat)

| What PR #65433 included | DennouAibou verdict |
|---|---|
| Gemini 3.1 template ID fix | ✅ **Take this** |
| Inbound NUL safety checks (`src/core/inbound.ts`) | ❌ Reject — out of scope, separate PR territory |
| Sonnet 4.6 default 1M context constant | ❌ Reject — Anthropic concern, not Gemini |

---

## 5. Expected Result After Fix

| Provider | Model selected by user | Template resolved | CLI receives |
|---|---|---|---|
| `google-gemini-cli` | `gemini-3.1-pro` | `gemini-3.1-pro-preview` | ✅ Valid ID |
| `google-gemini-cli` | `gemini-3.1-flash` | `gemini-3.1-flash-preview` | ✅ Valid ID |
| `google` (REST API) | `gemini-3.1-pro` | `gemini-3-pro-preview` (fallback) | ✅ Unchanged behavior |

---

## 🔧 Pro Engineer Review — 2026-04-14
> Perspective: Google / IBM Production Engineering
> Principles applied: YAGNI · KISS · DRY · SOLID
> Source code verified: ✅ (as of 2026-04-14)

### 📍 Current Reality (Source Code vs. Document)
- ✅ **Document matches code:** Verified `extensions/google/provider-models.ts` lines 17-19 exactly match the described legacy preview strings.
- ✅ **DennouAibou Rules alignment:** The decision to outright reject the upstream bloat (NUL safety / Sonnet parameters) strictly follows the "Smart Debloat" and "Defend the Hooks" directives in `DENNOU_RULES.md`.

### 🎯 Core Problem (1 sentence)
> The legacy `3.0-preview` fallback array breaks the modern `@google/gemini-cli` execution path which strictly requires a valid `3.1` model ID schema.

### 🔍 Principle Filter
| Check | Result | Note |
|-------|--------|------|
| **YAGNI** — Is this actually needed now? | ✅ **Yes** | Passing the correct 3.1 ID is essential to unblock the CLI runner. The externally bloated upstream features were rightfully discarded. |
| **KISS** — Is there a simpler solution? | ✅ **Simple enough** | Prepended the correct ID to the existing array. `cloneFirstTemplateModel` natively handles fallbacks. Elegant and minimal. |
| **DRY** — Any duplication to eliminate? | ✅ **None** | Reuses the existing `cloneFirstTemplateModel` logic path efficiently. |
| **SOLID** — Any violation causing real problems? | ✅ **None** | Expanding the literal array respects the Open-Closed Principle. |

### 🛤️ Solution Options

#### Option A — The "Surgical Array Prepend" *(推奨)*
**Approach**: Insert `gemini-3.1-pro-preview` as the first element of `GEMINI_3_1_PRO_TEMPLATE_IDS`, leaving the old string as a fallback.  
**Implementation cost**: Minimal (2 lines).  
**Risk**: Near Zero. `cloneFirstTemplateModel` protects against catastrophic missing references.  
**Why recommended**: Provides exactly what the CLI binary expects right now, maintaining stable backwards compatibility logic for the REST API if the template map varies. Matches exactly with your proposed document.  
**Concrete steps**:
1. Prepend `"gemini-3.1-pro-preview", ` to `GEMINI_3_1_PRO_TEMPLATE_IDS`.
2. Prepend `"gemini-3.1-flash-preview", ` to `GEMINI_3_1_FLASH_TEMPLATE_IDS`.

#### Option B — The "Full Hardcode Rewrite"
**Approach**: Completely replace the ID logic to skip `cliTemplateIds` iteration entirely for 3.1, passing strings directly.
**Implementation cost**: Medium. Let `isModernGoogleModel()` handle early return and bypass the family mapper entirely.
**Risk**: High. Could break the gateway's expected internal model ID resolution flow for edge cases.
**When to choose this instead**: Only if downstream dependencies suddenly strip array-based fallback logic. Not recommended now.

### ✅ Pro Recommendation
> **Choose Option A because**: It solves the bug strictly within the parameters of the current architecture's template fallback system, avoiding breaking changes while upholding the team's commitment to zero unneeded bloat.
> Estimated implementation: 1 minute (Ready to go).
> Rollback plan: Revert the two prepended string literals.

### ⚡ Quick Wins (implement regardless of option chosen)
- [ ] Proceed with Option A's implementation immediately. Do you want me to apply the code changes to your repo now?
