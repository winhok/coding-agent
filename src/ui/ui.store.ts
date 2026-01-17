import type { UIMessage } from "ai";
import { proxy } from "valtio";

type Approval = {
  toolName: string;
  args?: string;
  reason?: string;
  approved?: boolean;
  resolve: (approved: boolean) => void;
};

type UIStore = {
  messages: UIMessage[];
  isThinking: boolean;
  totalUsedTokens: number;
  maxContextWindowTokens: number;
  approval: Approval | undefined;
};

export const uiStore = proxy<UIStore>({
  messages: [],
  isThinking: false,
  totalUsedTokens: 0,
  maxContextWindowTokens: 100000,
  approval: undefined,
});
