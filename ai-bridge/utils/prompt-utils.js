/**
 * Shared prompt utility functions.
 */

/**
 * Build the Windows path format constraint prompt section.
 * Only returns content on Windows platform (process.platform === 'win32').
 *
 * @param {Object} [options] - Options
 * @param {string} [options.extra] - Additional instruction text appended after the base message
 * @returns {string} The constraint prompt section, or empty string on non-Windows
 */
export function getWindowsPathConstraint(options = {}) {
  if (process.platform !== 'win32') {
    return '';
  }

  const { extra = '' } = options;
  const extraText = extra ? ` ${extra}` : '';

  return `\n\n**File paths (Windows)**: use absolute paths with a drive letter and backslashes (e.g. \`C:\\Users\\name\\project\\src\\file.js\`) for all file operations \u2014 never Unix-style (\`/c/...\`) or relative (\`./src/...\`) paths.${extraText}\n\n`;
}
