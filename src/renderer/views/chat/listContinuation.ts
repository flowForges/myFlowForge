// Smart list continuation for the composer textarea. Given the current value + cursor, decide what a
// plain Enter should do when the cursor's line is a Markdown list item:
//   · non-empty item → CONTINUE: insert a newline + the next marker (1.→2., -→-, - [x]→- [ ]).
//   · empty item (marker only) → EXIT: strip the marker, leaving an empty line (Enter again then sends).
//   · not a list line → returns null so the caller falls through to its normal Enter (send).
// Pure string manipulation (no DOM) so it's unit-testable; the caller applies { value, cursor }.

export interface ListEdit { value: string; cursor: number }

// Ordered: "1." / "2)" ; Checkbox (test BEFORE bullet, since it starts with a bullet): "- [ ]" / "* [x]";
// Unordered: "-" / "*" / "+". Each captures the indent so nested lists keep their depth.
const ORDERED = /^(\s*)(\d+)([.)])(\s+)(.*)$/
const CHECKBOX = /^(\s*)([-*+])\s+\[[ xX]\](\s+)(.*)$/
const UNORDERED = /^(\s*)([-*+])(\s+)(.*)$/

// The marker to start the NEXT item, given a matched current line.
function nextMarker(line: string): { marker: string; content: string } | null {
  let m = CHECKBOX.exec(line)
  if (m) return { marker: `${m[1]}${m[2]} [ ]${m[3]}`, content: m[4] }
  m = ORDERED.exec(line)
  if (m) return { marker: `${m[1]}${Number(m[2]) + 1}${m[3]}${m[4]}`, content: m[5] }
  m = UNORDERED.exec(line)
  if (m) return { marker: `${m[1]}${m[2]}${m[3]}`, content: m[4] }
  return null
}

export function applyListContinuation(value: string, selStart: number, selEnd: number): ListEdit | null {
  // Only for a collapsed caret — a range selection keeps the normal Enter (send) behavior.
  if (selStart !== selEnd) return null
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1
  const nl = value.indexOf('\n', selStart)
  const lineEnd = nl === -1 ? value.length : nl
  const line = value.slice(lineStart, lineEnd)

  const next = nextMarker(line)
  if (!next) return null

  // Empty item (marker with no content) → exit the list: clear the line's text, keep the line.
  if (next.content.trim() === '') {
    return { value: value.slice(0, lineStart) + value.slice(lineEnd), cursor: lineStart }
  }
  // Non-empty item → continue: split at the caret, dropping the new marker in between.
  const insert = '\n' + next.marker
  return { value: value.slice(0, selStart) + insert + value.slice(selStart), cursor: selStart + insert.length }
}
