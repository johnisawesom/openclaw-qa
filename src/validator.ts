import { FixSuggestion, ReviewResponse } from "./types.js";

const VALID_ACTIONS = ["delete_line", "replace_line", "insert_after"] as const;

export function validateFix(fix: unknown): ReviewResponse {
  // Check fix is an object
  if (typeof fix !== "object" || fix === null) {
    return { status: "FAIL", reason: "Fix payload is not an object" };
  }

  const f = fix as Record<string, unknown>;

  // Check file field
  if (typeof f["file"] !== "string" || f["file"].trim() === "") {
    return { status: "FAIL", reason: "Missing or invalid field: file" };
  }

  if (!f["file"].startsWith("src/")) {
    return {
      status: "FAIL",
      reason: `Target file does not start with src/ — possible hallucination: ${f["file"]}`,
    };
  }

  if (!f["file"].endsWith(".ts")) {
    return {
      status: "FAIL",
      reason: `Target file does not end with .ts — possible hallucination: ${f["file"]}`,
    };
  }

  // Check line field
  if (typeof f["line"] !== "number" || !Number.isInteger(f["line"]) || f["line"] < 1) {
    return {
      status: "FAIL",
      reason: `Invalid line number: ${f["line"]} — must be a positive integer`,
    };
  }

  // Check action field
  if (!VALID_ACTIONS.includes(f["action"] as (typeof VALID_ACTIONS)[number])) {
    return {
      status: "FAIL",
      reason: `Invalid action: ${f["action"]} — must be delete_line, replace_line, or insert_after`,
    };
  }

  // Check newContent field
  if (typeof f["newContent"] !== "string") {
    return { status: "FAIL", reason: "Missing or invalid field: newContent" };
  }

  // Check description field
  if (typeof f["description"] !== "string" || f["description"].trim() === "") {
    return { status: "FAIL", reason: "Missing or invalid field: description" };
  }

  return {
    status: "PASS",
    reason: "Fix structure valid, target file path valid, line number valid",
  };
}
