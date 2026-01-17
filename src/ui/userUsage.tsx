import { ProgressBar } from "@inkjs/ui";
import { Box, Spacer, Text } from "ink";
import type { ReactNode } from "react";
import { useSnapshot } from "valtio";
import { theme } from "./theme.ts";
import { uiStore } from "./ui.store.ts";

function getUsageColor(percentage: number): string {
  if (percentage > 80) return theme.error;
  if (percentage > 50) return theme.warning;
  return theme.success;
}

export function UserUsage(): ReactNode {
  const snap = useSnapshot(uiStore);
  const ratio = snap.totalUsedTokens / snap.maxContextWindowTokens;
  const contextWindowPercentage = Math.round(ratio * 10000) / 100;

  const usageColor = getUsageColor(contextWindowPercentage);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Box gap={2}>
          <Text dimColor>
            <Text color={theme.primary}>⌨</Text> Ctrl+C to exit
          </Text>
          <Text dimColor>
            <Text color={theme.accent}>?</Text> for help
          </Text>
        </Box>
        <Spacer />
        <Box gap={2}>
          <Text dimColor>
            Tokens:{" "}
            <Text color={usageColor}>
              {snap.totalUsedTokens.toLocaleString()}
            </Text>
            <Text dimColor>
              {" "}
              / {snap.maxContextWindowTokens.toLocaleString()}
            </Text>
          </Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Context: </Text>
        <Box flexGrow={1}>
          <ProgressBar value={contextWindowPercentage} />
        </Box>
        <Text color={usageColor}> {contextWindowPercentage}%</Text>
      </Box>
    </Box>
  );
}
