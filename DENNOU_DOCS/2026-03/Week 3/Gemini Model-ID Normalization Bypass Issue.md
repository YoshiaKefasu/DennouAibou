# 🧠 AI_DEV_PLAN: Gemini Model-ID Normalization Bypass (Issue #65363)

## 1. The Context (The Threat)
OpenClaw attempted to implement "forward compatibility" for the `google-generative-ai` provider by creating a normalization layer. If a user points to a `gemini-3.1` model, the underlying code forcibly intercepts and downgrades the ID to a hardcoded `gemini-3.0-preview` template. 

While this might prevent crashes for the REST API wrapper, **it completely destroys the standalone `@google/gemini-cli` binary connection.** The CLI backend expects the raw, modern `3.1` ID string. By downgrading it, OpenClaw causes a fatal "communication failure" in the CLI runner path.

Upstream has an active PR for this (#65433), but it is a "kitchen sink" PR that bundles the Gemini fix with unrelated changes like "inbound NUL safety" and "Sonnet 4.6 context adjustments." We reject this bloat. DennouAibou will cherry-pick ONLY the model-ID mapping logic to keep our core lean.

## 2. The DennouAibou Surgical Plan (The Fix)
**Objective:** Bypass the normalization layer exclusively for CLI-based providers, ensuring zero overhead and preserving the CLI's native model resolution behavior.

### Target Concept
The core fault lies in the model string interception logic (historically `resolveGoogleGeminiForwardCompatModel` or equivalent mapping arrays in `provider-models.ts` or `provider-policy.ts`).

### The Clean Implementation (Debloated)
Instead of adding massive configuration matrices, we insert a strict bypass rule targeting the origin of the execution.

1. **Locate the Normalization Origin:**
   Identify where OpenClaw validates the `gemini-*` prefix.
2. **Inject the Firewall (The Bypass):**
   ```typescript
   // [FIX-UPSTREAM] DennouAibou Core Bypass
   // Do not downgrade or mutate the model ID if the request is routed bound for the CLI backend.
   if (context.providerName === "google-gemini-cli") {
       return originalModelId; // Return raw 3.1 ID immediately, skipping all legacy regex checks.
   }
   ```
3. **Clean Up Upstream Bloat (Optional but recommended):**
   Remove any unused arrays of hardcoded "legacy preview templates" if they serve no function other than legacy backward compatibility that we don't care about.

## 3. Execution Phase
- **Step A:** `grep` through the Google extension directory (`extensions/google/`) for the model normalization regex (e.g., `gemini-[0-9]+\.[0-9]+`).
- **Step B:** Apply the bypass logic above directly inside the resolver function.
- **Step C:** Commit with the `[FIX-UPSTREAM]` tag.
- **Result:** Gemini CLI immediately restores connection with `3.1` models, completely immune to OpenClaw's forced downgrades.
