import { Box, Text } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import type { ReactNode } from "react";
import { gradients, theme } from "./theme.ts";

export function BoxTitle(): ReactNode {
  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      <Gradient name={gradients.title}>
        <BigText font="chrome" text="CODING AGENT" />
      </Gradient>
      <Box gap={1}>
        <Text color={theme.primary}>●</Text>
        <Text dimColor>Powered by Claude</Text>
        <Text color={theme.primary}>●</Text>
      </Box>
    </Box>
  );
}
