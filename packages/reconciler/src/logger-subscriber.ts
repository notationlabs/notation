import type {
  OperationLifecycleEvent,
  OperationLifecycleReason,
  ReconcilerEvent,
  ReconcilerEventEmitter,
} from "./events";

export type Logger = Pick<Console, "info" | "warn" | "error">;

// Wraps text in a format such as "dim" or "red". `level` is the level of the
// event that the text belongs to, so a style can pick colours for the stream
// that the line goes to.
export type EventStyle = (
  format: "dim" | "green" | "red" | "cyan" | "yellow",
  text: string,
  level: ReconcilerEvent["level"],
) => string;

export type LoggerReconcilerSubscriberOptions = {
  logger?: Logger;
  // Defaults to plain text.
  style?: EventStyle;
};

const plain: EventStyle = (_, text) => text;

export function createLoggerReconcilerSubscriber(
  opts: LoggerReconcilerSubscriberOptions = {},
): ReconcilerEventEmitter {
  const logger = opts.logger ?? console;
  const style = opts.style ?? plain;

  return async (event: ReconcilerEvent) => {
    const line = formatPrettyEvent(event, style);
    if (line !== undefined) logger[event.level](line);
  };
}

const lifecycleReasons: Record<OperationLifecycleReason, string> = {
  "taken-over": "took over a resource that already existed",
  "dependency-replaced": "deleted before its dependency is replaced",
  retired: "the instance that a replace retired",
  "read-not-implemented": "the resource type has no read",
  "not-created": "the resource was never created",
  "key-unknown": "the key is not known",
  passed: "passed with --credential",
};

const replaceOrderLabels = {
  "create-first": "create, then delete",
  "delete-first": "delete, then create",
} as const;

type LineStyle = (format: Parameters<EventStyle>[0], text: string) => string;

const formatTarget = (style: LineStyle, id: string, type: string) =>
  `${id} ${style("dim", type)}`;

// Returns undefined for events that pretty output leaves out.
export function formatPrettyEvent(
  event: ReconcilerEvent,
  eventStyle: EventStyle = plain,
): string | undefined {
  const style: LineStyle = (format, text) =>
    eventStyle(format, text, event.level);
  switch (event.event) {
    case "reconciler.operation.lifecycle":
      return formatLifecycleEvent(event, style);
    case "reconciler.deploy.decision": {
      if (event.decision === "noop") return undefined;
      const details: string[] = [];
      if (event.replaceFields?.length) {
        details.push(
          event.replaceFields
            .map((field) => {
              if (field.requested) return "replaced by --replace";
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
        ` ${event.decision} ${formatTarget(style, event.resourceId, event.resourceType)}${suffix}`
      );
    }
    case "reconciler.drift.detected":
      return (
        style("cyan", "~") +
        ` drift ${formatTarget(style, event.resourceId, event.resourceType)}\n    ` +
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
        ` did not delete ${formatTarget(style, event.resourceId, event.resourceType)}` +
        style("dim", ` (resource type not registered${kept})`)
      );
    }
    case "reconciler.provider.load-failed":
      return (
        style("yellow", "!") +
        ` could not load provider ${event.provider}: ${event.errorMessage}`
      );
    case "reconciler.source.warning":
      return (
        style("yellow", "!") +
        ` ${formatTarget(style, event.resourceId, event.resourceType)} ${event.message}`
      );
    case "reconciler.source.notice":
      return (
        style("dim", "…") +
        ` ${event.message}` +
        style("dim", ` (${event.resourceType})`)
      );
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function formatLifecycleEvent(
  event: OperationLifecycleEvent,
  style: LineStyle,
): string {
  const credential = event.credential ? ` ${event.credential} of` : "";
  const subject = `${event.operation}${credential} ${formatTarget(style, event.resourceId, event.resourceType)}`;
  const details: string[] = [];
  if (event.reason) details.push(lifecycleReasons[event.reason]);
  if (event.replacedDependency) {
    details.push(`dependency ${event.replacedDependency}`);
  }
  if (event.status === "skip") details.push("skipped");
  if (event.status === "dry-run") details.push("dry run");
  const suffix = details.length ? style("dim", ` (${details.join(", ")})`) : "";
  switch (event.status) {
    case "start":
      return style("dim", "…") + ` ${subject}${suffix}`;
    case "success":
      return style("green", "✓") + ` ${subject}${suffix}`;
    case "skip":
      return style("dim", `- ${subject}`) + suffix;
    case "dry-run":
      return style("cyan", "○") + ` ${subject}${suffix}`;
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
