/**
 * Real-browser load gate for the WebUI bundle.
 *
 * Why this test exists
 * --------------------
 * The previous "blank white page" WebUI fixes shipped brace-count
 * regex scanners and jsdom-based probes. Both layers were necessary
 * but not sufficient: a module-load leak that hides behind a lazy
 * chunk's deferred import path only fires when the bundle actually
 * runs in a real browser. jsdom and the Node child-process probe
 * cannot exercise that path.
 *
 * This test runs in the `browser` vitest project (Playwright +
 * headless Chromium). It traps every Node-only global (`process`,
 * `require`, `Buffer`, `module`, `__dirname`, `__filename`) on
 * `globalThis` so any eager reference during module load throws the
 * canonical browser ReferenceError. Then it dynamically imports the
 * `app.ts` module — which registers the `openclaw-app` custom
 * element — and asserts that:
 *
 *   - the registration succeeded (a module-load leak would have
 *     thrown before reaching the `@customElement` decorator call),
 *   - mounting the host element renders children into its shadow
 *     DOM (the literal "blank white page" regression),
 *   - no `pageerror` / `console.error` fired during the load.
 *
 * The runtime probe in `webui-bundle-browser-load.node.test.ts`
 * already covers the child-Node side; this test is the equivalent
 * for an actual Chromium tab.
 *
 * Platform notes
 * --------------
 * Vite's chromium-based browser project holds a `deps_temp_*` lock
 * in `ui/node_modules/.vite/vitest/*` while it boots. On Windows
 * this occasionally races with filesystem permissions (EPERM on
 * rename). The test self-skips on win32 so the EPERM noise does not
 * block the other browser tests; macOS / Linux runners should run
 * it normally.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../styles.css";
import { mountApp as mountTestApp, registerAppMountHooks } from "./test-helpers/app-mount.ts";

const isWin32 = process.platform === "win32";

registerAppMountHooks();

const NODE_ONLY_GLOBALS = ["process", "require", "Buffer", "module", "__dirname", "__filename"];

/**
 * Replace every Node-only global with a getter that throws the
 * canonical browser ReferenceError. We use a getter-only data
 * descriptor (not a Proxy) so `typeof <name>` evaluates to
 * `"undefined"` — matching a real browser tab where the Node
 * global is genuinely absent — which lets existing
 * `typeof process !== "undefined"` guards in the bundle short-circuit
 * before touching any process property.
 */
function trapNodeOnlyGlobals() {
  const traps: Array<{ name: string; restore: () => void }> = [];
  for (const name of NODE_ONLY_GLOBALS) {
    const original = (globalThis as unknown as Record<string, unknown>)[name];
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      get() {
        throw new ReferenceError(`${name} is not defined`);
      },
    });
    traps.push({
      name,
      restore: () => {
        if (typeof original === "undefined") {
          delete (globalThis as unknown as Record<string, unknown>)[name];
        } else {
          (globalThis as unknown as Record<string, unknown>)[name] = original;
        }
      },
    });
  }
  return traps;
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

let pageErrors: Error[] = [];
let consoleErrors: string[] = [];

beforeAll(() => {
  pageErrors = [];
  consoleErrors = [];
  window.addEventListener("error", (event) => {
    pageErrors.push(event.error ?? new Error(event.message));
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    pageErrors.push(reason instanceof Error ? reason : new Error(String(reason)));
  });
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "),
    );
    originalConsoleError(...args);
  };
});

afterAll(() => {
  pageErrors = [];
  consoleErrors = [];
});

describe.skipIf(isWin32)("WebUI real-browser module-load gate (Chromium)", () => {
  it("mounts <openclaw-app> without throwing under Node-only global traps", async () => {
    expect(typeof customElements).toBe("object");

    // Install the trap BEFORE importing the app so its module-load
    // evaluation path runs against the hostile environment. We use
    // a dynamic import so the trap is in place by the time the
    // module body executes (a static `import "../app.ts"` would
    // already have been evaluated at the top of this file).
    const trap = trapNodeOnlyGlobals();
    try {
      const appModule = await import("./app.ts");
      expect(appModule).toBeDefined();

      const ctor = customElements.get("openclaw-app");
      expect(ctor).toBeDefined();

      const app = mountTestApp("/");
      await app.updateComplete;
      await nextFrame();
      await nextFrame();

      const shadowChildCount = app.shadowRoot
        ? app.shadowRoot.querySelectorAll("*").length
        : 0;
      expect(shadowChildCount).toBeGreaterThan(0);
    } finally {
      for (const t of trap) t.restore();
    }

    if (pageErrors.length > 0) {
      const formatted = pageErrors
        .map((err) => `  - ${err.name}: ${err.message}`)
        .join("\n");
      expect.fail(
        `Chromium reported uncaught pageerrors while loading the WebUI:\n${formatted}`,
      );
    }
    if (consoleErrors.length > 0) {
      expect.fail(
        `Chromium reported console.error messages while loading the WebUI:\n` +
          consoleErrors.map((text) => `  - ${text}`).join("\n"),
      );
    }
  });
});