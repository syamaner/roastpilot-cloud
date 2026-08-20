/** Shared, single-line patterns for locating acceptance-criteria sections. */
export const ACCEPTANCE_CRITERIA_HEADING_LINE_PATTERN =
  /^ {0,3}(#{1,6})\s*acceptance criteria(?:\s+#+)?\s*$/i;

/** Any Markdown ATX heading line, with its opening level captured. */
export const ANY_HEADING_LINE_PATTERN = /^ {0,3}(#{1,6})\s+\S/;

/** Any non-empty GFM checkbox-shaped list item. */
export const CHECKBOX_LINE_PATTERN =
  /^\s*(?:[-*+]|\d+[.)])\s*\[( |x|X)\]\s*(.+)$/;
