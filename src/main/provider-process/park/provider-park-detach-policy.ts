let detachArmed = false

/** Armed once an update quit begins; closes then detach instead of stopping the provider group. */
export function armProviderParkDetach(): void {
  detachArmed = true
}

export function providerParkDetachArmed(): boolean {
  return detachArmed
}

/** Test isolation and a retracted update quit both need the policy lowered again. */
export function disarmProviderParkDetach(): void {
  detachArmed = false
}
