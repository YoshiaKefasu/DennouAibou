import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHighlightCode,
  lightPalette,
  markdownTheme,
  resolveLightMode,
  searchableSelectListTheme,
  selectListTheme,
  theme,
} from "./theme.js";

const cliHighlightMocks = {
  highlight: vi.fn((code: string) => code),
  supportsLanguage: vi.fn((_lang: string) => true),
};

const highlightCode = createHighlightCode(cliHighlightMocks);

const stripAnsi = (str: string) =>
  str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) {
    throw new Error(`invalid color: ${hex}`);
  }
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

describe("markdownTheme", () => {
  describe("highlightCode", () => {
    beforeEach(() => {
      cliHighlightMocks.highlight.mockClear();
      cliHighlightMocks.supportsLanguage.mockClear();
      cliHighlightMocks.highlight.mockImplementation((code: string) => code);
      cliHighlightMocks.supportsLanguage.mockReturnValue(true);
    });

    it("passes supported language through to the highlighter", () => {
      highlightCode("const x = 42;", "javascript");
      expect(cliHighlightMocks.supportsLanguage).toHaveBeenCalledWith("javascript");
      expect(cliHighlightMocks.highlight).toHaveBeenCalledWith(
        "const x = 42;",
        expect.objectContaining({ language: "javascript" }),
      );
    });

    it("falls back to auto-detect for unknown language and preserves lines", () => {
      cliHighlightMocks.supportsLanguage.mockReturnValue(false);
      cliHighlightMocks.highlight.mockImplementation((code: string) => `${code}\nline-2`);
      const result = highlightCode(`echo "hello"`, "not-a-real-language");
      expect(cliHighlightMocks.highlight).toHaveBeenCalledWith(
        `echo "hello"`,
        expect.objectContaining({ language: undefined }),
      );
      expect(stripAnsi(result[0] ?? "")).toContain("echo");
      expect(stripAnsi(result[1] ?? "")).toBe("line-2");
    });

    it("returns plain highlighted lines when highlighting throws", () => {
      cliHighlightMocks.highlight.mockImplementation(() => {
        throw new Error("boom");
      });
      const result = highlightCode("echo hello", "javascript");
      expect(result).toHaveLength(1);
      expect(stripAnsi(result[0] ?? "")).toBe("echo hello");
    });

    it("wires the default highlighter into markdownTheme", () => {
      expect(markdownTheme.highlightCode).toBeTypeOf("function");
      expect(markdownTheme.highlightCode!("const x = 1;", "javascript").length).toBeGreaterThan(0);
    });
  });
});

describe("theme", () => {
  it("keeps assistant text in terminal default foreground", () => {
    expect(theme.assistantText("hello")).toBe("hello");
    expect(stripAnsi(theme.assistantText("hello"))).toBe("hello");
  });
});

describe("light background detection", () => {
  it("uses dark palette by default", () => {
    expect(resolveLightMode({})).toBe(false);
  });

  it("selects light palette when DENNOU_THEME=light", () => {
    expect(resolveLightMode({ DENNOU_THEME: "light" })).toBe(true);
  });

  it("selects dark palette when DENNOU_THEME=dark", () => {
    expect(resolveLightMode({ DENNOU_THEME: "dark" })).toBe(false);
  });

  it("treats DENNOU_THEME case-insensitively", () => {
    expect(resolveLightMode({ DENNOU_THEME: "LiGhT" })).toBe(true);
  });

  it("detects light background from COLORFGBG", () => {
    expect(resolveLightMode({ COLORFGBG: "0;15" })).toBe(true);
  });

  it("treats COLORFGBG bg=7 (silver) as light", () => {
    expect(resolveLightMode({ COLORFGBG: "0;7" })).toBe(true);
  });

  it("treats COLORFGBG bg=8 (bright black / dark gray) as dark", () => {
    expect(resolveLightMode({ COLORFGBG: "15;8" })).toBe(false);
  });

  it("treats COLORFGBG bg < 7 as dark", () => {
    expect(resolveLightMode({ COLORFGBG: "15;0" })).toBe(false);
  });

  it("treats 256-color COLORFGBG bg=232 (near-black greyscale) as dark", () => {
    expect(resolveLightMode({ COLORFGBG: "15;232" })).toBe(false);
  });

  it("treats 256-color COLORFGBG bg=255 (near-white greyscale) as light", () => {
    expect(resolveLightMode({ COLORFGBG: "0;255" })).toBe(true);
  });

  it("treats 256-color COLORFGBG bg=231 (white cube entry) as light", () => {
    expect(resolveLightMode({ COLORFGBG: "0;231" })).toBe(true);
  });

  it("treats 256-color COLORFGBG bg=16 (black cube entry) as dark", () => {
    expect(resolveLightMode({ COLORFGBG: "15;16" })).toBe(false);
  });

  it("treats bright 256-color green backgrounds as light when dark text contrasts better", () => {
    expect(resolveLightMode({ COLORFGBG: "15;34" })).toBe(true);
  });

  it("treats bright 256-color cyan backgrounds as light when dark text contrasts better", () => {
    expect(resolveLightMode({ COLORFGBG: "15;39" })).toBe(true);
  });

  it("falls back to dark mode for invalid COLORFGBG values", () => {
    expect(resolveLightMode({ COLORFGBG: "garbage" })).toBe(false);
  });

  it("ignores pathological COLORFGBG values", () => {
    expect(resolveLightMode({ COLORFGBG: "0;".repeat(40) })).toBe(false);
  });

  it("DENNOU_THEME overrides COLORFGBG", () => {
    expect(resolveLightMode({ DENNOU_THEME: "dark", COLORFGBG: "0;15" })).toBe(false);
  });

  it("keeps assistantText as identity in both modes", () => {
    expect(theme.assistantText("hello")).toBe("hello");
  });
});

describe("light palette accessibility", () => {
  it("keeps light theme text colors at WCAG AA contrast or better", () => {
    const backgrounds = {
      page: "#FFFFFF",
      user: lightPalette.userBg,
      pending: lightPalette.toolPendingBg,
      success: lightPalette.toolSuccessBg,
      error: lightPalette.toolErrorBg,
      code: lightPalette.codeBlock,
    };

    const textPairs = [
      [lightPalette.text, backgrounds.page],
      [lightPalette.dim, backgrounds.page],
      [lightPalette.accent, backgrounds.page],
      [lightPalette.accentSoft, backgrounds.page],
      [lightPalette.systemText, backgrounds.page],
      [lightPalette.link, backgrounds.page],
      [lightPalette.quote, backgrounds.page],
      [lightPalette.error, backgrounds.page],
      [lightPalette.success, backgrounds.page],
      [lightPalette.userText, backgrounds.user],
      [lightPalette.dim, backgrounds.pending],
      [lightPalette.dim, backgrounds.success],
      [lightPalette.dim, backgrounds.error],
      [lightPalette.toolTitle, backgrounds.pending],
      [lightPalette.toolTitle, backgrounds.success],
      [lightPalette.toolTitle, backgrounds.error],
      [lightPalette.toolOutput, backgrounds.pending],
      [lightPalette.toolOutput, backgrounds.success],
      [lightPalette.toolOutput, backgrounds.error],
      [lightPalette.code, backgrounds.code],
      [lightPalette.border, backgrounds.page],
      [lightPalette.quoteBorder, backgrounds.page],
      [lightPalette.codeBorder, backgrounds.page],
    ] as const;

    for (const [foreground, background] of textPairs) {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("list themes", () => {
  it("reuses shared select-list styles in searchable list theme", () => {
    expect(searchableSelectListTheme.selectedPrefix(">")).toBe(selectListTheme.selectedPrefix(">"));
    expect(searchableSelectListTheme.selectedText("entry")).toBe(
      selectListTheme.selectedText("entry"),
    );
    expect(searchableSelectListTheme.description("desc")).toBe(selectListTheme.description("desc"));
    expect(searchableSelectListTheme.scrollInfo("scroll")).toBe(
      selectListTheme.scrollInfo("scroll"),
    );
    expect(searchableSelectListTheme.noMatch("none")).toBe(selectListTheme.noMatch("none"));
  });

  it("keeps searchable list specific renderers readable", () => {
    expect(stripAnsi(searchableSelectListTheme.searchPrompt("Search:"))).toBe("Search:");
    expect(stripAnsi(searchableSelectListTheme.searchInput("query"))).toBe("query");
    expect(stripAnsi(searchableSelectListTheme.matchHighlight("match"))).toBe("match");
  });
});
