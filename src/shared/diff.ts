export function createSimpleDiff(before: string, after: string, maxLines = 180): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const max = Math.max(a.length, b.length);
  const out: string[] = ["--- before", "+++ after"];
  let emitted = 0;
  for (let i = 0; i < max; i++) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      continue;
    }
    if (typeof left !== "undefined") {
      out.push(`-${left}`);
      emitted++;
    }
    if (typeof right !== "undefined") {
      out.push(`+${right}`);
      emitted++;
    }
    if (emitted >= maxLines) {
      out.push("... diff truncated ...");
      break;
    }
  }
  if (out.length === 2) {
    return "No changes.";
  }
  return out.join("\n");
}
