export interface FixSuggestion {
  file: string;
  line: number;
  action: "delete_line" | "replace_line" | "insert_after";
  newContent: string;
  description: string;
}

export interface ReviewRequest {
  prUrl: string;
  fix: FixSuggestion;
}

export interface ReviewResponse {
  status: "PASS" | "FAIL";
  reason: string;
}
