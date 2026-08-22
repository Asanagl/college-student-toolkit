import packageJson from "../../package.json";

/**
 * Product version shown in the app and written to backup manifests.
 *
 * Store may use a higher package identity version for a resubmission while
 * the feature release remains 0.3.0, so runtime UI must not read app.asar's
 * packaging metadata directly.
 */
export const PRODUCT_VERSION = packageJson.version;
