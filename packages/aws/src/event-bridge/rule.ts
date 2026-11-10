import type { StandardSchemaV1 } from "@notation/resource";
import { resolveLambda, whenLoaded } from "src/lambda/lambda-declaration";
import type { EventBridgeRuleEvent, RuleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import type { NameSafe } from "src/id";
import { EventBus } from "./event-bus";
import { RuleGroup } from "./rule-group";

export type RuleConfig = RuleOptions & {
  /** The bus that the rule matches events on, from `eventBus()` or `defaultEventBus()`. */
  bus: EventBus<any>;
  /**
   * The Lambda that the rule sends the events to: a declaration from
   * `$lambda`, passed as `() => lambda`, or a Lambda group from `lambda()`. A
   * declaration must be declared with
   * `event: () => eventBridge.schema(schema)`, or with no event.
   */
  target: RuleTarget;
};

/**
 * A Lambda that can receive the events of a rule or a schedule. `S` is the
 * schema of a declaration's `eventBridge.schema()`: a detail schema for the
 * events of a rule, or `null` for scheduled events.
 */
export type RuleTarget<S extends StandardSchemaV1 | null = StandardSchemaV1> =
  | (() => {
      readonly "~lambda"?:
        | { kind: "none" }
        | { kind: "eventBridge"; event: EventBridgeRuleEvent<S> };
    })
  | LambdaGroup;

/**
 * Sends the events on a bus that match a pattern to a Lambda. The rule is
 * made when infra has finished loading. A declaration can make its own rule,
 * with `event: () => eventBridge.bind(bus).defineRule(options)`. `id` must be
 * a name-safe string literal; see `NameSafe`.
 * @resource
 */
export function rule<const Id extends string>(
  config: Omit<RuleConfig, "id"> & { id: NameSafe<Id> },
): void {
  const { bus, target, ...options } = config;
  // The bus is read now, not when infra has loaded. An import cycle can make
  // it undefined here.
  if (!(bus instanceof EventBus)) {
    throw new Error(
      `rule() with id "${config.id}" needs a bus from eventBus() or defaultEventBus(), but its bus is ${bus === undefined ? "undefined" : typeof bus}. If the bus is imported, check for an import cycle.`,
    );
  }
  whenLoaded(() => {
    const { group, event } = resolveLambda(target, "rule()", "eventBridge");
    if (event?.kind === "eventBridge" && event.schema === null) {
      throw new Error(
        `rule() sends the events of a rule, but the Lambda "${group.id}" is declared with event: () => eventBridge.schema(null), which receives scheduled events. Declare it with event: () => eventBridge.schema(schema).`,
      );
    }
    new RuleGroup(bus, options, group, "rule()");
  });
}
