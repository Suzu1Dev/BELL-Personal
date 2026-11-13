/**
 * Removes comments and the listed elements (with their content) from HTML in
 * one linear pass, for the plain-text extractors of mail bodies and LMS
 * descriptions. An element or comment that never closes hides the rest of the
 * text, as a browser would. Lazy regexes such as `<style[\s\S]*?<\/style>`
 * take quadratic time on many unclosed openings; this scan never searches the
 * same stretch twice.
 */
export function stripHiddenElements(html: string, names: readonly string[]): string {
  const opening = new RegExp(`<(${names.join("|")})\\b`, "gi");
  let out = "";
  let index = 0;
  // Each search result is kept until the scan passes it.
  let comment = -2;
  let element: RegExpExecArray | null | undefined;
  while (index < html.length) {
    if (comment !== -1 && comment < index) comment = html.indexOf("<!--", index);
    if (element !== null && (!element || element.index < index)) {
      opening.lastIndex = index;
      element = opening.exec(html);
    }
    const elementAt = element ? element.index : -1;
    if (comment < 0 && elementAt < 0) break;
    if (comment >= 0 && (elementAt < 0 || comment < elementAt)) {
      out += `${html.slice(index, comment)} `;
      const end = html.indexOf("-->", comment + 4);
      if (end < 0) return out;
      index = end + 3;
      continue;
    }
    out += `${html.slice(index, elementAt)} `;
    const closing = new RegExp(`<\\/${element![1]}\\s*>`, "gi");
    closing.lastIndex = elementAt + element![0].length;
    const close = closing.exec(html);
    if (!close) return out;
    index = close.index + close[0].length;
  }
  return out + html.slice(index);
}
