/* eslint-env node */

/**
 * Store-only AppX/MSIX container configuration.
 *
 * The local defaults are deliberately non-production values.  A Store build
 * must receive the exact Partner Center identity through environment
 * variables; no certificate, private key, or account token belongs here.
 */
// Partner Center rejects a non-zero fourth Windows version component. A
// resubmission therefore overrides package metadata with a three-part version
// (for example 0.3.1), which electron-builder emits as 0.3.1.0.
const packageVersion = process.env.APPX_PACKAGE_VERSION?.trim() || undefined;
if (packageVersion && !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error(
    "APPX_PACKAGE_VERSION 必须是三段纯数字版本（例如 0.3.1），Store manifest 会使用第四段 0。",
  );
}

module.exports = {
  extends: "./electron-builder.yml",
  extraMetadata: packageVersion ? { version: packageVersion } : undefined,
  directories: {
    output: process.env.APPX_OUTPUT_DIR || "release-v0.3.0-msix-local",
  },
  win: {
    target: [{ target: "appx", arch: ["x64"] }],
  },
  appx: {
    artifactName: "college-student-toolkit-${version}-${arch}.msix",
    identityName:
      process.env.APPX_IDENTITY_NAME || "college-student-toolkit-local",
    applicationId: process.env.APPX_APPLICATION_ID || "CollegeStudentToolkit",
    publisher: process.env.APPX_PUBLISHER || "CN=ms",
    publisherDisplayName:
      process.env.APPX_PUBLISHER_DISPLAY_NAME || "大学生工具组",
    displayName: "大学生工具组",
    backgroundColor: "#1677ff",
    languages: ["zh-CN", "en-US"],
    electronUpdaterAware: false,
    setBuildNumber: false,
  },
  // The Store owns package updates; do not emit GitHub updater metadata.
  publish: null,
};
