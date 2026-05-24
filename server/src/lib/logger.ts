import { putObject } from './s3';

export type UpdateOutcome =
  | 'update_served'
  | 'no_update'
  | 'rollback'
  | 'bad_request'
  | 'not_found'
  | 'error';

export interface RequestLog {
  requestId: string;
  timestamp: string;
  platform: string | undefined;
  runtimeVersion: string | undefined;
  currentUpdateId: string | undefined;
  embeddedUpdateId: string | undefined;
  protocolVersion: number;
  outcome: UpdateOutcome;
  statusCode: number;
  updateBundlePath?: string;
  manifestId?: string;
  error?: string;
}

/**
 * Writes a structured JSON log entry to S3 at:
 *   logs/YYYY-MM-DD/{ISO_timestamp}_{requestId}.json
 *
 * Fire-and-forget errors are swallowed — a logging failure must never
 * break the manifest response the device is waiting for.
 */
export async function writeRequestLog(log: RequestLog): Promise<void> {
  const date = log.timestamp.slice(0, 10); // "YYYY-MM-DD"
  const safeTs = log.timestamp.replace(/[:.]/g, '-');
  const key = `logs/${date}/${safeTs}_${log.requestId}.json`;
  try {
    await putObject(key, JSON.stringify(log, null, 2));
  } catch {
    // intentionally silent
  }
}
