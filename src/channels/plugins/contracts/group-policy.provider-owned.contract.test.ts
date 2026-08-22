import { describe } from "vitest";

// zalo was removed during DEBLOAT; its setup facade no longer resolves.
// Provider-owned group access evaluation is now covered by the
// line/discord/telegram channel contracts.
describe("channel runtime group policy provider-owned contract", () => {
  // intentionally empty — deleted channel (zalo) tests removed
});
