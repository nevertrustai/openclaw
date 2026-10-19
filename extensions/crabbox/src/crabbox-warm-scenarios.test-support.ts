import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { crabboxState, openWarmImageStore } from "./crabbox-state.test-support.js";
import {
  listCrabboxWarmImages,
  type WarmImageRecord,
  type WarmProfileRecord,
} from "./crabbox-worker-warm-image-store.js";
import type { CommandCall } from "./crabbox-worker-warm-image.test-support.js";

export const firstWarmImage = async () => (await listCrabboxWarmImages(crabboxState))[0];
export const checkpointArgs = (calls: CommandCall[], action: string) =>
  calls.filter(({ argv }) => argv[2] === action).map(({ argv }) => argv);
export const commandArgs = (calls: CommandCall[], action: string) =>
  calls.filter(({ argv }) => argv[1] === action).map(({ argv }) => argv);

export async function closeWarmState(provider: WorkerProvider) {
  await provider.dispose();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}

export function warmEntry() {
  const entry = openWarmImageStore().entries()[0];
  if (!entry) {
    throw new Error("Expected a captured warm image");
  }
  return entry;
}

export function updateWarmImage(patch: Partial<WarmImageRecord>) {
  const entry = warmEntry();
  openWarmImageStore().register(entry.key, {
    ...entry.value,
    image: { ...entry.value.image!, ...patch },
  });
  return entry;
}

export const warmImage = (
  checkpointId: string,
  overrides: Partial<WarmImageRecord> = {},
): WarmImageRecord => ({
  checkpointId,
  kind: "native",
  state: "available",
  createdAtMs: 1,
  preparationKey: null,
  cacheKey: null,
  purpose: null,
  lastDemandAtMs: 1,
  ...overrides,
});

export const warmRecord = (overrides: Partial<WarmProfileRecord> = {}): WarmProfileRecord => ({
  version: 3,
  allocations: {},
  ...overrides,
});
