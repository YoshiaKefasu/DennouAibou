/**
 * UI-local mirror of the UI-used subset of `src/cron/types-shared.ts`.
 *
 * The original upstream definition is generic over several sub-types; the
 * UI only ever instantiates one concrete form, so we preserve the generic
 * shape here. When upstream adds or removes a field, mirror it here.
 *
 * Source of truth: `src/cron/types-shared.ts` (HEAD).
 */
export type CronJobBase<
  TSchedule = unknown,
  TSessionTarget = unknown,
  TWakeMode = unknown,
  TPayload = unknown,
  TDelivery = unknown,
  TFailureAlert = unknown,
> = {
  id: string;
  agentId?: string;
  sessionKey?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: TSchedule;
  sessionTarget: TSessionTarget;
  wakeMode: TWakeMode;
  payload: TPayload;
  delivery?: TDelivery;
  failureAlert?: TFailureAlert;
};
