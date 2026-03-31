/** @format */

import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  FILE_REVIEW_SYSTEM_LINES,
  MAIN_SYSTEM_LINES,
} from "./templates/review-system.js";
import { TRIAGE_SYSTEM_LINES } from "./templates/triage-system.js";

export const buildMainSystemMessages = (): ChatCompletionMessageParam[] => [
  {
    role: "system",
    content: MAIN_SYSTEM_LINES.join("\n"),
  },
];

export const TRIAGE_SYSTEM: ChatCompletionMessageParam = {
  role: "system",
  content: TRIAGE_SYSTEM_LINES.join("\n"),
};

export const FILE_REVIEW_SYSTEM: ChatCompletionMessageParam = {
  role: "system",
  content: FILE_REVIEW_SYSTEM_LINES.join("\n"),
};
