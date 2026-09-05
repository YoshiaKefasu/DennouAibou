import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

type GuidanceCase = {
  file: string;
  required?: string[];
  forbidden?: string[];
};

const CASES: GuidanceCase[] = [
  {
    file: "skills/session-logs/SKILL.md",
    required: ["DENNOU_STATE_DIR"],
    forbidden: [
      "for f in ~/.dennou-aibou/agents/<agentId>/sessions/*.jsonl",
      'rg -l "phrase" ~/.dennou-aibou/agents/<agentId>/sessions/*.jsonl',
      "~/.dennou-aibou/agents/<agentId>/sessions/<id>.jsonl",
    ],
  },
  {
    file: "skills/gh-issues/SKILL.md",
    required: ["DENNOU_CONFIG_PATH"],
    forbidden: ["cat ~/.dennou-aibou/dennou-aibou.json"],
  },
  {
    file: "skills/canvas/SKILL.md",
    required: ["DENNOU_CONFIG_PATH"],
    forbidden: ["cat ~/.dennou-aibou/dennou-aibou.json"],
  },
  {
    file: "skills/openai-whisper-api/SKILL.md",
    required: ["DENNOU_CONFIG_PATH"],
  },
  {
    file: "skills/coding-agent/SKILL.md",
    required: ["DENNOU_STATE_DIR"],
    forbidden: ["NEVER start Codex in ~/.dennou-aibou/"],
  },
];

describe("bundled skill env-path guidance", () => {
  it.each(CASES)(
    "keeps $file aligned with OPENCLAW env overrides",
    ({ file, required, forbidden }) => {
      const content = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const needle of required ?? []) {
        expect(content).toContain(needle);
      }
      for (const needle of forbidden ?? []) {
        expect(content).not.toContain(needle);
      }
    },
  );
});
