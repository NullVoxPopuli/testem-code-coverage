export const REPORT_TO_MIDDLEWARE_PATH = "/__testem-code-coverage__/coverage";

/** Normalize path separators to POSIX-style forward slashes. */
export function toPosixPath(filePath) {
  return String(filePath).replace(/\\/g, "/");
}
