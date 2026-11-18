import { readDevinCredentials } from '../providers/devin/devin-credentials'
import { fetchDevinRateLimits } from '../providers/devin/devin-usage-fetcher'
import {
  settleSiblingProviderFetch,
  type SettledProviderResult
} from './service-sibling-provider-result'

export function prepareDevinUsageFetch(signal: AbortSignal): {
  authConfigured: boolean
  resultPromise: Promise<SettledProviderResult>
} {
  const credentialReadResult = readDevinCredentials()
  return {
    authConfigured: credentialReadResult.status === 'ok',
    resultPromise: settleSiblingProviderFetch(
      fetchDevinRateLimits({ signal, credentialReadResult })
    )
  }
}
