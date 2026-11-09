// Why a fetch of opportunities ran. Stored as text on IngestionJob.trigger and
// SourceSyncRun.trigger; rows from before this was recorded have none.
export const FETCH_TRIGGERS = ['SCHEDULE', 'RESTART', 'SYNC_BUTTON', 'ON_DEMAND'] as const
export type FetchTrigger = (typeof FETCH_TRIGGERS)[number]
