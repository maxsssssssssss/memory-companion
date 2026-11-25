const quotedPairs: Readonly<Record<string, string>> = {
  "「": "」", "『": "』", "“": "”", "‘": "’", '"': '"', "'": "'"
};

/** Outermost quotation spans, including the delimiters. In a streamed prefix an open quote lasts to EOF. */
export function qaQuotedRanges(text: string) {
  const ranges: { start: number; end: number }[] = [];
  const closers: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && /[\\"']/u.test(text[i + 1] ?? "")) {
      i++;
      continue;
    }
    const afterWord = /[A-Za-z0-9]/u.test(text[i - 1] ?? "");
    if ((ch === "'" || ch === "’") && afterWord && /[A-Za-z0-9]/u.test(text[i + 1] ?? "")) continue;

    if (ch === closers.at(-1)) {
      closers.pop();
      if (!closers.length) ranges.push({ start, end: i + 1 });
    } else if (quotedPairs[ch]) {
      // A trailing apostrophe or an inch mark does not start an English quotation.
      if ((ch === "'" || ch === '"') && afterWord) continue;
      if (!closers.length) start = i;
      closers.push(quotedPairs[ch]);
    }
  }
  if (closers.length) ranges.push({ start, end: text.length });
  return ranges;
}

export function mapUnquotedQaText(text: string, transform: (part: string, start: number) => string): string {
  const ranges = qaQuotedRanges(text);
  if (!ranges.length) return transform(text, 0);
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (cursor < start) parts.push(transform(text.slice(cursor, start), cursor));
    parts.push(text.slice(start, end));
    cursor = end;
  }
  if (cursor < text.length) parts.push(transform(text.slice(cursor), cursor));
  return parts.join("");
}

/** Remove evidence suffixes from prose. Quoted labels and unrecognized IDs remain verbatim. */
export function projectQaCitationText(text: string, ids: ReadonlySet<string>): string {
  if (!ids.size) return text;
  const suffixOrSpace = /[ \t]*(\[E[1-9]\d*\](?:[ \t]*\[E[1-9]\d*\])*)|[ \t]+/gu;
  return mapUnquotedQaText(text, (part, start) =>
    part.replace(suffixOrSpace, (group, markers: string | undefined, index: number) => {
      if (!markers) return group;
      const followsQuote = start > 0 && index === 0;
      let previous = start + index - 1;
      while (previous >= 0 && /["'”’」』）)\]}]/u.test(text[previous])) previous--;
      const followsBoundary = /[。！？.!?；;，,]/u.test(text[previous] ?? "");
      const after = text.slice(start + index + group.length);
      const endsUnit = /^[ \t]*(?:[。！？!?；;，,\r\n]|\.(?=\s|$)|$)/u.test(after);
      if (!followsQuote && !followsBoundary && !endsUnit) return group;
      return group.replace(/[ \t]*\[(E[1-9]\d*)\]/gu, (marker, id: string) => ids.has(id) ? "" : marker);
    })
  );
}
