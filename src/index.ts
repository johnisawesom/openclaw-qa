import express, { Request, Response } from "express";
import { validateFix } from "./validator.js";
import { ReviewRequest, ReviewResponse } from "./types.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT ?? "8080";

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", bot: "openclaw-qa", version: "1.0.0" });
});

// Review endpoint
app.post("/review", (req: Request, res: Response) => {
  console.log("[QA] Received review request");

  const body = req.body as Partial<ReviewRequest>;

  if (!body.prUrl || typeof body.prUrl !== "string") {
    const response: ReviewResponse = {
      status: "FAIL",
      reason: "Missing or invalid field: prUrl",
    };
    console.log(`[QA] FAIL — ${response.reason}`);
    res.status(400).json(response);
    return;
  }

  if (!body.fix) {
    const response: ReviewResponse = {
      status: "FAIL",
      reason: "Missing field: fix",
    };
    console.log(`[QA] FAIL — ${response.reason}`);
    res.status(400).json(response);
    return;
  }

  const result = validateFix(body.fix);

  console.log(`[QA] ${result.status} — ${result.reason}`);
  res.status(result.status === "PASS" ? 200 : 400).json(result);
});

// Boot
app.listen(parseInt(PORT), "0.0.0.0", () => {
  console.log(`[QA] Boot confirmed — openclaw-qa v1.0.0`);
  console.log(`[QA] Health server on port ${PORT}`);
});
