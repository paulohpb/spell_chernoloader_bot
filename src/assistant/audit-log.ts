/**
 * =============================================================================
 * Audit Log - Global logging utility
 * Replaces console.log and console.error throughout the application
 * =============================================================================
 */

export interface AuditLogEntry {
  timestamp: string;
  code: string;
  meta: Record<string, unknown>;
}

export interface AuditLog {
  record: (code: string, meta: Record<string, unknown>) => void;
  trace: (msg: string) => void;
}

/**
 * Creates the global audit log instance
 */
function createAuditLog(): AuditLog {
  const record = (code: string, meta: Record<string, unknown>): void => {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      code,
      meta,
    };
    // In production, this could write to a file, send to a logging service, etc.
    // For now, we use stderr for errors to maintain visibility
    process.stderr.write(JSON.stringify(entry) + '\n');
  };

  const trace = (msg: string): void => {
    // Debug tracing - only output in development
    if (process.env.NODE_ENV !== 'production') {
      process.stdout.write(`[TRACE] ${new Date().toISOString()} ${msg}\n`);
    }
  };

  return { record, trace };
}

/**
 * Global audit log instance
 */
export const auditLog = createAuditLog();
