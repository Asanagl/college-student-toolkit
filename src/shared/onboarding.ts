import type { OnboardingState } from "./types";

/**
 * An existing profile must not be interrupted by a first-run welcome dialog.
 * A completed marker always wins so a user who deliberately skipped the guide
 * is not prompted again after the profile becomes empty.
 */
export function resolveOnboardingState(
  completedMarker: boolean | undefined,
  hasExistingUserData: boolean,
): OnboardingState {
  if (completedMarker === true || hasExistingUserData) {
    return { required: false, completed: true };
  }
  if (completedMarker === false) {
    return { required: true, completed: false };
  }
  return { required: true, completed: false };
}
