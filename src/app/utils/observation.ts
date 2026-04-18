export function isFailureObservation(summary: string): boolean {
  const lower = summary.toLowerCase();
  return lower.includes("tool error") ||
    lower.includes("result: failed") ||
    lower.includes("result: timeout") ||
    lower.includes("exit_code: -1") ||
    lower.includes("not found");
}

export function summarizeObservationForUi(
  summary: string,
  status: "done" | "error",
): string {
  if (status === "error") {
    if (summary.toLowerCase().includes("timeout")) return "Timed out";
    if (summary.toLowerCase().includes("not found")) return "Not found";
    return "Failed";
  }
  return "Completed";
}
