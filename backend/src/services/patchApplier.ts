/**
 * Unified diff parser and applier for the apply_patch tool.
 * More robust than edit_file's string-match approach because it uses
 * line numbers and context lines as anchors.
 */

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // prefixed with '+', '-', or ' '
}

export interface PatchResult {
  success: boolean;
  newContent: string;
  error?: string;
  hunksApplied: number;
}

/**
 * Parse a unified diff string into an array of hunks.
 * Handles standard unified diff format:
 *   --- a/file
 *   +++ b/file
 *   @@ -oldStart,oldCount +newStart,newCount @@ context
 *    context line
 *   -removed line
 *   +added line
 */
export function parseUnifiedDiff(diff: string): Hunk[] {
  // Normalize CRLF: otherwise an empty context line is '\r', which matches
  // none of the prefixes below and truncates the hunk at the first blank line.
  const lines = diff.replace(/\r\n?/g, '\n').split('\n');
  const hunks: Hunk[] = [];
  let i = 0;

  // Skip header lines (--- and +++)
  while (i < lines.length && !lines[i]!.startsWith('@@')) {
    i++;
  }

  while (i < lines.length) {
    const headerLine = lines[i];
    if (!headerLine?.startsWith('@@')) {
      i++;
      continue;
    }

    // Parse @@ -oldStart,oldCount +newStart,newCount @@
    const match = headerLine.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
      i++;
      continue;
    }

    const hunk: Hunk = {
      oldStart: parseInt(match[1]!, 10),
      oldCount: match[2] ? parseInt(match[2], 10) : 1,
      newStart: parseInt(match[3]!, 10),
      newCount: match[4] ? parseInt(match[4], 10) : 1,
      lines: [],
    };

    i++;

    // Read hunk lines until next @@ or end
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) break;
      if (line.startsWith('@@')) break;
      if (line === '') {
        // Could be end of hunk or an empty context line.
        // If we've consumed enough lines for this hunk, stop.
        const contextCount = hunk.lines.filter(l => l.startsWith(' ')).length;
        const addCount = hunk.lines.filter(l => l.startsWith('+')).length;
        const delCount = hunk.lines.filter(l => l.startsWith('-')).length;
        if (contextCount + addCount >= hunk.newCount && contextCount + delCount >= hunk.oldCount) {
          break;
        }
        // Treat as empty context line
        hunk.lines.push(' ');
      } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
        hunk.lines.push(line);
      } else if (line.startsWith('\\ No newline at end of file')) {
        // Ignore this marker
      } else {
        break;
      }
      i++;
    }

    hunks.push(hunk);
  }

  return hunks;
}

/**
 * Apply parsed hunks to file content.
 * Uses context line matching for robustness against small drifts.
 */
export function applyHunks(content: string, hunks: Hunk[]): PatchResult {
  // Work on LF-normalized lines and restore the file's own line ending on
  // output, so CRLF files neither mismatch context nor come back mixed.
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = content.replace(/\r\n?/g, '\n').split('\n');
  let hunksApplied = 0;

  // Apply hunks in reverse order so line numbers remain valid
  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sortedHunks) {
    // Build the new lines for this hunk
    const newLines: string[] = [];
    const expectedOldLines: string[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith(' ') || line.startsWith('-')) {
        expectedOldLines.push(line.slice(1));
      }
      if (line.startsWith(' ') || line.startsWith('+')) {
        newLines.push(line.slice(1));
      }
    }

    // 1-based -> 0-based. A pure insertion (`-N,0`) inserts *after* line N,
    // and `@@ -0,0 +1,N @@` (new file / top of file) inserts at index 0 —
    // `oldStart - 1` would be -1 there, and splice(-1) inserts before the
    // last line instead.
    const startIdx = expectedOldLines.length === 0
      ? Math.max(0, Math.min(hunk.oldStart, fileLines.length))
      : Math.max(0, hunk.oldStart - 1);

    // Verify context matches (with tolerance for whitespace drift). Lines
    // past EOF must not "match" expected blank lines.
    const actualLines = fileLines.slice(startIdx, startIdx + expectedOldLines.length);
    let contextMatches = actualLines.length === expectedOldLines.length;

    for (let j = 0; contextMatches && j < expectedOldLines.length; j++) {
      const expected = expectedOldLines[j]?.trim() ?? '';
      const actual = actualLines[j]?.trim() ?? '';
      if (expected !== actual) {
        contextMatches = false;
        break;
      }
    }

    if (!contextMatches) {
      // Try fuzzy matching: search for the context in a window around the expected position
      const window = 5;
      let foundAt = -1;
      for (let offset = -window; offset <= window; offset++) {
        const tryStart = Math.max(0, startIdx + offset);
        const tryLines = fileLines.slice(tryStart, tryStart + expectedOldLines.length);
        let match = tryLines.length === expectedOldLines.length;
        for (let j = 0; match && j < expectedOldLines.length; j++) {
          if ((tryLines[j]?.trim() ?? '') !== (expectedOldLines[j]?.trim() ?? '')) {
            match = false;
            break;
          }
        }
        if (match) {
          foundAt = tryStart;
          break;
        }
      }

      if (foundAt === -1) {
        return {
          success: false,
          newContent: content,
          error: `Hunk at line ${hunk.oldStart} failed: context mismatch. Expected "${expectedOldLines[0]?.slice(0, 60)}..." but found "${actualLines[0]?.slice(0, 60)}..."`,
          hunksApplied,
        };
      }

      // Apply at the found position
      fileLines.splice(foundAt, expectedOldLines.length, ...newLines);
    } else {
      // Direct replacement
      fileLines.splice(startIdx, expectedOldLines.length, ...newLines);
    }

    hunksApplied++;
  }

  return {
    success: true,
    newContent: fileLines.join(eol),
    hunksApplied,
  };
}
