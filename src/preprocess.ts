import { DiagnosticBag } from './types.js';

export interface Line {
  /** Text of the line, tabs in leading whitespace expanded, no terminator. */
  text: string;
  /** 1-based line number in the original source. */
  lineNo: number;
}

/**
 * Normalize raw source into lines the block parser can trust:
 *  - strip BOM
 *  - normalize CRLF / CR to LF
 *  - expand tabs in *leading* whitespace to 4-space tab stops (interior tabs
 *    are preserved — they may be meaningful inside code)
 *  - replace non-breaking spaces in leading whitespace with regular spaces
 *  - strip zero-width characters (U+200B, U+200C, U+200D, interior U+FEFF)
 */
export function toLines(src: string, diag: DiagnosticBag): Line[] {
  if (src.charCodeAt(0) === 0xfeff) {
    src = src.slice(1);
    diag.note('doc-stripped-bom', 'Stripped byte-order mark at start of document', 1);
  }

  if (src.includes('\r')) {
    diag.note('doc-normalized-line-endings', 'Normalized CRLF/CR line endings to LF', 1);
    src = src.replace(/\r\n?/g, '\n');
  }

  const rawLines = src.split('\n');
  const lines: Line[] = [];
  let reportedInvisible = false;

  for (let i = 0; i < rawLines.length; i++) {
    let text = rawLines[i]!;

    // Strip only the truly decorative invisibles. U+200D (ZWJ) and U+200C
    // (ZWNJ) are load-bearing inside emoji sequences and in Indic, Arabic and
    // Persian text, so they stay.
    if (/[​﻿]/.test(text)) {
      text = text.replace(/[​﻿]/g, '');
      if (!reportedInvisible) {
        diag.note('doc-invisible-chars', 'Removed zero-width spaces', i + 1);
        reportedInvisible = true;
      }
    }

    // Expand leading whitespace: tabs advance to the next 4-column tab stop,
    // NBSP (U+00A0) counts as a regular space. Interior whitespace untouched.
    let col = 0;
    let j = 0;
    let sawNbsp = false;
    while (j < text.length) {
      const ch = text[j]!;
      if (ch === ' ') col++;
      else if (ch === ' ') {
        col++;
        sawNbsp = true;
      } else if (ch === '\t') col += 4 - (col % 4);
      else break;
      j++;
    }
    if (j > 0) {
      const rest = text.slice(j);
      const hadTabOrNbsp = /[\t ]/.test(text.slice(0, j));
      if (hadTabOrNbsp) {
        text = ' '.repeat(col) + rest;
        if (sawNbsp && !reportedInvisible) {
          diag.note('doc-invisible-chars', 'Non-breaking spaces in indentation treated as spaces', i + 1);
          reportedInvisible = true;
        }
      }
    }

    lines.push({ text, lineNo: i + 1 });
  }

  return lines;
}

/** Width of leading spaces (lines are already tab-expanded). */
export function indentOf(text: string): number {
  let n = 0;
  while (n < text.length && text[n] === ' ') n++;
  return n;
}

export function isBlank(text: string): boolean {
  return /^\s*$/.test(text);
}
