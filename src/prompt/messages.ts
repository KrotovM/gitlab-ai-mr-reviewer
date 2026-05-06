/** @format */

import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  getFileReviewSystemLines,
  getMainSystemLines,
} from "./templates/review-system.js";
import { getTriageSystemLines } from "./templates/triage-system.js";
import type { PromptProfile } from "./profile.js";
import { DEFAULT_PROMPT_PROFILE } from "./profile.js";

export const buildMainSystemMessages = (
  profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
): ChatCompletionMessageParam[] => [
  {
    role: "system",
    content: getMainSystemLines(profile).join("\n"),
  },
];

export const buildTriageSystemMessage = (
  profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
): ChatCompletionMessageParam => ({
  role: "system",
  content: getTriageSystemLines(profile).join("\n"),
});

export const buildFileReviewSystemMessage = (
  profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
): ChatCompletionMessageParam => ({
  role: "system",
  content: getFileReviewSystemLines(profile).join("\n"),
});

/** @deprecated kept for backward compatibility — use buildTriageSystemMessage(). */
export const TRIAGE_SYSTEM: ChatCompletionMessageParam =
  buildTriageSystemMessage();

/** @deprecated kept for backward compatibility — use buildFileReviewSystemMessage(). */
export const FILE_REVIEW_SYSTEM: ChatCompletionMessageParam =
  buildFileReviewSystemMessage();
