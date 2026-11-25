import type { InitializeResponse } from '../../generated/acp-protocol.generated'
import type { AcpStructuredLaunch } from '../../launch/acp-structured-launch-resolution'

/** The launch's sessionMeta, unless the agent's initialize says it cannot take it; then a required
 *  meta aborts the start while an optional one is dropped. */
export function acpUsableSessionMeta(
  launch: AcpStructuredLaunch,
  initialized: InitializeResponse,
  agentName: string
): Readonly<Record<string, unknown>> | undefined {
  const refused = Boolean(
    launch.sessionMeta && launch.takesSessionMeta && !launch.takesSessionMeta(initialized)
  )
  if (refused && !launch.sessionMetaOptional) {
    const version = initialized.agentInfo?.version
    throw new Error(
      `${agentName}${version ? ` ${version}` : ''} cannot take this chat's standing instructions, so it did not start`
    )
  }
  return refused ? undefined : launch.sessionMeta
}
