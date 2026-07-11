/** Join class names into a single string, dropping falsy (`""`/`false`/`null`/`undefined`) entries. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
