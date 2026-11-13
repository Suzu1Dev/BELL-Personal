/** Joins class names, skipping falsy ones: cx("btn", primary && "btn-primary"). */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
