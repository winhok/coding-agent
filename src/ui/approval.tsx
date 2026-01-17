import { ConfirmInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { useSnapshot } from "valtio";
import { boxStyles, theme } from "./theme.ts";
import { uiStore } from "./ui.store.ts";

export function Approval(): ReactNode {
  const snap = useSnapshot(uiStore);
  const approval = snap.approval;

  if (!approval) return null;

  return (
    <Box
      flexDirection="column"
      borderStyle={boxStyles.approval}
      borderColor={theme.warning}
      paddingX={2}
      paddingY={1}
      marginX={2}
    >
      <Box gap={2} marginBottom={1}>
        <Text color={theme.warningBright}>⚠</Text>
        <Text color={theme.warningBright} bold>
          Tool Approval Required
        </Text>
      </Box>

      <Box paddingLeft={3} flexDirection="column" gap={1}>
        <Text>
          <Text dimColor>Tool: </Text>
          <Text color={theme.tool.name} bold>
            {approval.toolName}
          </Text>
        </Text>

        {approval.args && (
          <Text>
            <Text dimColor>Args: </Text>
            <Text color={theme.tool.input}>{approval.args}</Text>
          </Text>
        )}

        {approval.reason && (
          <Text>
            <Text dimColor>Reason: </Text>
            <Text>{approval.reason}</Text>
          </Text>
        )}
      </Box>

      <Box marginTop={1} gap={2}>
        <Text color={theme.successBright}>
          <ConfirmInput
            submitOnEnter
            onConfirm={() => approval.resolve(true)}
            onCancel={() => approval.resolve(false)}
          />
        </Text>
        <Text dimColor>
          Press <Text color={theme.success}>Y</Text> to approve,{" "}
          <Text color={theme.error}>N</Text> to reject
        </Text>
      </Box>
    </Box>
  );
}
