import { RELEASE_CONFIG } from "./releaseConfig";

/**
 * Product version shown in the app and written to backup manifests.
 *
 * Store may use a higher package identity version for a resubmission while
 * the feature release remains independent from Store identity, so runtime UI
 * must not read app.asar's packaging metadata directly.
 */
export const PRODUCT_VERSION = RELEASE_CONFIG.productVersion;
