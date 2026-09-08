/** Split display text without changing the original imported notes. */
export function splitHistoryNotes(notes) {
  const text = String(notes ?? '');
  const marker = /【(?:推测日期|日期推测)】/.exec(text);
  return marker
    ? {note:text.slice(0, marker.index).trim(), evidence:text.slice(marker.index).trim(), inferred:true}
    : {note:text.trim(), evidence:'', inferred:false};
}
