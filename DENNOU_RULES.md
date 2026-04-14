# 🛡️ DennouAibou: Rules of Engagement

If we are going to build an omnipotent Cyber-VTuber partner on top of a rapidly changing upstream project (OpenClaw), we need defense mechanisms. 

If we blindly delete lines of code to remove bloat, or scatter our custom "Soul" logic across their core files, the next upstream `git merge` will be a living nightmare of merge conflicts.

To survive and evolve, strictly adhere to these four architectural laws:

## Rule 1: Isolate the "Soul" (Encapsulation)
**Do not mix our custom VTuber logic with the upstream core engine.**
The OpenClaw engine (parsing, routing, basic LLM execution) should remain as untouched as possible. Any functionality specific to DennouAibou—like the "Bond" system, episodic memory enhancements, or avatar integration—must be isolated into dedicated directories (e.g., `src/dennou-soul/` or treated as internal standalone plugins). We inject our features using Hooks, not by hardcoding them into the core.

## Rule 2: Smart Debloating
**Cut the wires, don't shred the components.**
When ripping out useless corporate integrations or bloatware, avoid deleting random lines of code inside massive core files. Git hates this when syncing. 
- **Preferred Method:** Disable the feature at the entry point. Comment out the plugin registration or use Feature Flags so the code is simply never loaded.
- **Nuclear Method:** If an upstream plugin is complete garbage and we will never use it, delete the *entire* plugin folder. Git handles folder-level deletions/additions flawlessly during merges.

## Rule 3: Defend the Hooks
**If the upstream breaks the very hooks we rely on, we fix their code.**
As seen with the `cli-runner` regression, sometimes the upstream architects make mistakes that silently disable critical expansion points (`before_prompt_build`, etc.). In these cases, we proactively patch the core files to restore architectural sanity. We do this cleanly, mimicking how they *should* have done it, so that when they finally issue an official fix, our code merges with theirs seamlessly.

## Rule 4: Commit Taxonomy
**Tag it or lose it.**
To maintain sanity when reviewing history or preparing for an upstream sync, every commit must be prefixed:
* `[SOUL]` : Adding or modifying our custom Cyber-VTuber/Partner logic.
* `[DEBLOAT]` : Disabling, optimizing, or removing upstream bloatware.
* `[FIX-UPSTREAM]` : Proactively fixing a bug or architectural flaw caused by the upstream developers.
* `[SYNC]` : Merging changes, tags, or commits explicitly from the OpenClaw origin.

---
*Follow these rules, and DennouAibou will outlive the tools it was born from.*
