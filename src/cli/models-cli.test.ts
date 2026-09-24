import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerModelsCli } from "./models-cli.js";

const mocks = vi.hoisted(() => ({
  modelsStatusCommand: vi.fn().mockResolvedValue(undefined),
  noopAsync: vi.fn(async () => undefined),
  modelsAuthLoginCommand: vi.fn().mockResolvedValue(undefined),
}));

const { modelsStatusCommand, modelsAuthLoginCommand } = mocks;

vi.mock("../commands/models.js", () => ({
  modelsStatusCommand: mocks.modelsStatusCommand,
  modelsAliasesAddCommand: mocks.noopAsync,
  modelsAliasesListCommand: mocks.noopAsync,
  modelsAliasesRemoveCommand: mocks.noopAsync,
  modelsAuthAddCommand: mocks.noopAsync,
  modelsAuthLoginCommand: mocks.modelsAuthLoginCommand,
  modelsAuthOrderClearCommand: mocks.noopAsync,
  modelsAuthOrderGetCommand: mocks.noopAsync,
  modelsAuthOrderSetCommand: mocks.noopAsync,
  modelsAuthPasteTokenCommand: mocks.noopAsync,
  modelsAuthSetupTokenCommand: mocks.noopAsync,
  modelsFallbacksAddCommand: mocks.noopAsync,
  modelsFallbacksClearCommand: mocks.noopAsync,
  modelsFallbacksListCommand: mocks.noopAsync,
  modelsFallbacksRemoveCommand: mocks.noopAsync,
  modelsImageFallbacksAddCommand: mocks.noopAsync,
  modelsImageFallbacksClearCommand: mocks.noopAsync,
  modelsImageFallbacksListCommand: mocks.noopAsync,
  modelsImageFallbacksRemoveCommand: mocks.noopAsync,
  modelsListCommand: mocks.noopAsync,
  modelsScanCommand: mocks.noopAsync,
  modelsSetCommand: mocks.noopAsync,
  modelsSetImageCommand: mocks.noopAsync,
}));

describe("models cli", () => {
  beforeEach(() => {
    modelsStatusCommand.mockClear();
  });

  function createProgram() {
    const program = new Command();
    registerModelsCli(program);
    return program;
  }

  async function runModelsCommand(args: string[]) {
    await runRegisteredCli({
      register: registerModelsCli as (program: Command) => void,
      argv: args,
    });
  }

  it.each([
    { label: "status flag", args: ["models", "status", "--agent", "poe"] },
    { label: "parent flag", args: ["models", "--agent", "poe", "status"] },
  ])("passes --agent to models status ($label)", async ({ args }) => {
    await runModelsCommand(args);
    expect(modelsStatusCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "poe" }),
      expect.any(Object),
    );
  });
});
