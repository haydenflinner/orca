import { AcpRpcError } from '../transport/acp-errors'
import type { AcpRequestContext } from '../transport/acp-json-rpc-peer'
import { answerAcpPermission, readAcpPermissionRequest } from './acp-permission-requests'
import { readAcpSessionEvent, type AcpSessionEvent } from './acp-session-events'
import type { AcpSessionRuntimeOptions } from './acp-session-runtime-options'
import type { AcpSessionStarted } from './acp-session-setup'

/** Agent→client requests and notifications, dispatched with the runtime's options and listeners. */
export class AcpSessionInbound {
  private reportedUpdateAnomaly = false

  constructor(
    private readonly options: AcpSessionRuntimeOptions,
    private readonly started: () => AcpSessionStarted | undefined,
    private readonly listeners: Set<(event: AcpSessionEvent) => void>
  ) {}

  request(method: string, params: unknown, context: AcpRequestContext): unknown {
    if (method !== 'session/request_permission') {
      if (!this.options.onRequest) {
        throw new AcpRpcError(-32601, `Unknown ACP client method: ${method}`)
      }
      return this.options.onRequest(method, params, context)
    }
    const diagnose = (message: string): void => this.diagnose(message)
    const request = readAcpPermissionRequest(params, diagnose)
    if (!request) {
      throw new AcpRpcError(-32602, 'Invalid ACP permission request')
    }
    // Only the started session asks the caller; the caller decides who can answer.
    if (request.sessionId !== this.started()?.sessionId) {
      return { outcome: { outcome: 'cancelled' } }
    }
    return answerAcpPermission(request, context, this.options.onPermission, diagnose)
  }

  notification(method: string, params: unknown): void {
    if (method !== 'session/update') {
      try {
        this.options.onExtensionNotification?.(method, params)
      } catch (error) {
        this.diagnose(`ACP extension listener failed: ${String(error)}`)
      }
      return
    }
    const event = readAcpSessionEvent(params)
    if (!event) {
      this.diagnose('Ignored invalid ACP session update envelope')
      return
    }
    if (event.kind === 'unrecognized' && !this.reportedUpdateAnomaly) {
      this.reportedUpdateAnomaly = true
      this.diagnose('Forwarded unrecognized ACP session update')
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.diagnose(`ACP event listener failed: ${String(error)}`)
      }
    }
  }

  private diagnose(message: string): void {
    try {
      this.options.onDiagnostic?.(message)
    } catch {
      /* Diagnostics cannot prevent event delivery. */
    }
  }
}
