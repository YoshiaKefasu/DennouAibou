import { describe, expect, it, vi } from "vitest";
import { scheduleDetachedLaunchdRestartHandoff } from "./launchd-restart-handoff.js";

describe("scheduleDetachedLaunchdRestartHandoff", () => {
  it("waits for the caller pid before kickstarting launchd", () => {
    const env = {
      HOME: "/Users/test",
      DENNOU_PROFILE: "default",
    };
    const unref = vi.fn();
    const spawn = vi.fn().mockReturnValue({ pid: 4242, unref });

    const result = scheduleDetachedLaunchdRestartHandoff({
      env,
      mode: "kickstart",
      waitForPid: 9876,
      spawn,
    });

    expect(result).toEqual({ ok: true, pid: 4242 });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = spawn.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe("-c");
    expect(args[2]).toBe("openclaw-launchd-restart-handoff");
    expect(args[6]).toBe("9876");
    expect(args[1]).toContain('while kill -0 "$wait_pid" >/dev/null 2>&1; do');
    expect(args[1]).toContain('launchctl kickstart -k "$service_target" >/dev/null 2>&1');
    expect(args[1]).not.toContain("sleep 1");
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
