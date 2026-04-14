# 🏗️ Architecture Borders

To maintain sanity when merging changes from the `OpenClaw` upstream, we must strictly respect the borders between their infrastructure and our "Soul."

## 1. Upstream Territory (Handle with Care)
Files in `src/core/*`, `src/parsers/*`, and official upstream `extensions/*`.
- **Rule:** Do not edit these files to add VTuber or Persona logic.
- **Exception:** You MAY edit these files proactively to fix critical bugs (e.g., the `cli-runner` Hook Bypass issue) IF your fix mimics how upstream would eventually fix it. Tag these commits with `[FIX-UPSTREAM]`.

## 2. DennouAibou Territory (Our Domain)
This directory (`DENNOU_DOCS/`), any future `src/dennou-soul/` directories, and our custom VTuber plugins.
- **Rule:** Upstream will never touch these. Go wild. Write your most ambitious code here.

## 3. The Demilitarized Zone (DMZ)
Files like `package.json`, `index.ts`, and core plugin configuration matrices.
- **Rule:** This is where we act as a surgeon. We modify these files strictly to **comment out** or **disable** upstream bloatware (`[DEBLOAT]`). Do not delete lines; disable and comment so Git can merge cleanly when upstream bumps a version.
