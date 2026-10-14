import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  type HarnessOptions,
  type Registry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

/** Model ref of the faux test provider's default model (`fauxProvider()`). */
export const FAUX_MODEL = { provider: "faux", modelId: "faux-1" } as const;

export type OpenHarnessOptions = {
  readonly registry?: Registry;
  readonly env?: HarnessOptions["env"];
};

export type HarnessBundle = {
  readonly harness: Harness;
  readonly models: MutableModels;
};

function harnessOptions(
  provider: Provider,
  options: OpenHarnessOptions | undefined,
): { readonly bundle: HarnessOptions; readonly models: MutableModels } {
  const models = createModels();
  models.setProvider(provider);
  return {
    bundle: {
      models,
      registry: options?.registry ?? createRegistry(),
      env: options?.env,
    },
    models,
  };
}

/** Open a Harness over in-memory storage (nothing survives close). */
export async function openMemoryHarness(
  provider: Provider,
  options?: OpenHarnessOptions,
): Promise<HarnessBundle> {
  const { bundle, models } = harnessOptions(provider, options);
  const harness = await Harness.open(new MemoryStorage(), bundle, BACKGROUND_CONTEXT);
  return { harness, models };
}

/** Open a Harness over a file-backed SQLite storage (survives reopen). */
export async function openSqliteHarness(
  path: string,
  provider: Provider,
  options?: OpenHarnessOptions,
): Promise<HarnessBundle> {
  const { bundle, models } = harnessOptions(provider, options);
  const harness = await Harness.open(await openNodeSqliteStorage(path), bundle, BACKGROUND_CONTEXT);
  return { harness, models };
}
