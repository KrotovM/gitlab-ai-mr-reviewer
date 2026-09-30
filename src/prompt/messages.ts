/** @format */

import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  getFileReviewSystemPrompt,
  getMainSystemPrompt,
} from "./templates/review-system.js";
import { getTriageSystemPrompt } from "./templates/triage-system.js";
import type { PromptProfile } from "./profile.js";
import { DEFAULT_PROMPT_PROFILE } from "./profile.js";

export const buildMainSystemMessages = (
  profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
): ChatCompletionMessageParam[] => [
  {
    role: "system",
    content: getMainSystemPrompt(profile),
  },
];

export const buildTriageSystemMessage = (
  profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
): ChatCompletionMessageParam => ({
  role: "system",
  content: getTriageSystemPrompt(profile),
});

export const buildFileReviewSystemMessage = (
  profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
): ChatCompletionMessageParam => ({
  role: "system",
  content: getFileReviewSystemPrompt(profile),
});
