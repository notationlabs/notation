import {
  createNdjsonEventEmitter,
  type ReconcilerEvent,
  type ReconcilerEventEmitter,
} from "@notation/core";
import { styleText } from "node:util";
import type { Logger } from "./logger";
import { redirectStdoutToStderr } from "./stdio";

export type OutputMode = "pretty" | "json";

type Style = (format: Parameters<typeof styleText>[0], text: string) => string;

/**
 * `--json` gives JSON and `--pretty` gives pretty output. Without either
 * flag, the output is pretty on a terminal and JSON otherwise.
 */
export function resolveOutputMode(
  flags: { json?: boolean; pretty?: boolean },
  stdout: { isTTY?: boolean } = process.stdout,
): OutputMode {
  if (flags.json) return "json";
  if (flags.pretty) return "pretty";
  return stdout.isTTY ? "pretty" : "json";
}

/**
 * In JSON mode, events go to stdout as NDJSON, and all other output moves to
 * stderr.
 */
export function createEventRenderer(
  mode: OutputMode,
  logger: Logger,
): ReconcilerEventEmitter {
  if (mode === "json") {
    return createNdjsonEventEmitter(redirectStdoutToStderr().write);
  }
  // styleText drops the colours when stdout is not a terminal or NO_COLOR is set.
  const style: Style = (format, text) =>
    styleText(format, text, { stream: process.stdout });
  return (event) => {
    const line = formatPrettyEvent(event, style);
    if (line !== undefined) logger[event.level](line);
  };
}

const lifecycleReasons: Record<string, string> = {
  "taken-over": "took over a resource that already existed",
  "dependency-replaced": "deleted before its dependency is replaced",
  retired: "the instance that a replace retired",
};

const replaceOrderLabels = {
  "create-first": "create, then delete",
  "delete-first": "delete, then create",
} as const;

/** Returns undefined for events that pretty output leaves out. */
export function formatPrettyEvent(
  event: ReconcilerEvent,
  style: Style = (_, text) => text,
): string | undefined {
  const target = (id: string, type: string) => `${id} ${style("dim", type)}`;

  switch (event.event) {
    case "reconciler.operation.lifecycle": {
      const credential = event.credential ? ` ${event.credential} of` : "";
      const subject = `${event.operation}${credential} ${target(event.resourceId, event.resourceType)}`;
      const details: string[] = [];
      if (event.reason) {
        details.push(lifecycleReasons[event.reason] ?? event.reason);
      }
      if (event.replacedDependency) {
        details.push(`dependency ${event.replacedDependency}`);
      }
      const suffix = details.length
        ? style("dim", ` (${details.join(", ")})`)
        : "";
      switch (event.status) {
        case "start":
          return style("dim", "…") + ` ${subject}${suffix}`;
        case "success":
          return style("green", "✓") + ` ${subject}${suffix}`;
        case "skip":
          return style("dim", `- ${subject} (skipped)`);
        case "dry-run":
          return style("cyan", "○") + ` ${subject}${suffix} (dry run)`;
        case "error": {
          const error = [event.errorName, event.errorMessage]
            .filter(Boolean)
            .join(": ");
          return (
            style("red", "✗") +
            ` ${subject}${suffix}` +
            (error ? `\n    ${style("red", error)}` : "")
          );
        }
      }
    }
    case "reconciler.deploy.decision": {
      if (event.decision === "noop") return undefined;
      const details: string[] = [];
      if (event.replaceFields?.length) {
        details.push(
          event.replaceFields
            .map((field) => {
              if (field.requested) return "requested by --replace";
              if (field.credential) return `${field.name} needs a new value`;
              return field.known ? field.name : `${field.name}?`;
            })
            .join(", "),
        );
      }
      if (event.replaceOrder) {
        details.push(replaceOrderLabels[event.replaceOrder]);
      }
      if (event.placeholder) details.push("placeholder");
      const suffix = details.length
        ? style("dim", ` (${details.join("; ")})`)
        : "";
      return (
        style("cyan", "→") +
        ` ${event.decision} ${target(event.resourceId, event.resourceType)}${suffix}`
      );
    }
    case "reconciler.drift.detected":
      return (
        style("yellow", "!") +
        ` drift ${target(event.resourceId, event.resourceType)}\n    ` +
        style("dim", JSON.stringify(event.diff))
      );
    case "reconciler.hold.waiting":
      return (
        style("yellow", "!") +
        ` waiting for execution ${event.holderExecutionId}, which holds ` +
        `${event.deploymentId}`
      );
    case "reconciler.orphan-deletion.skipped": {
      const kept = event.keptDependencies.length
        ? `; kept ${event.keptDependencies.join(", ")}`
        : "";
      return (
        style("yellow", "!") +
        ` did not delete ${target(event.resourceId, event.resourceType)}` +
        style("dim", ` (resource type not registered${kept})`)
      );
    }
    case "reconciler.provider.load-failed":
      return (
        style("yellow", "!") +
        ` could not load provider ${event.provider}: ${event.errorMessage}`
      );
  }
}
