import { vi } from "vitest";

type OpenAIMockInstance = {
  chat: {
    completions: {
      create: ReturnType<typeof vi.fn>;
    };
  };
};

const openAICreateMock = vi.fn(async () => {
  throw new Error("OpenAI mock is active. Override in test.");
});

export const openAIConstructorMock = vi.fn((): OpenAIMockInstance => {
  return {
    chat: {
      completions: {
        create: openAICreateMock,
      },
    },
  };
});

vi.mock("openai", () => {
  return {
    default: openAIConstructorMock,
  };
});

(globalThis as { __openAICreateMock?: typeof openAICreateMock }).__openAICreateMock =
  openAICreateMock;
