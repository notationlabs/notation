import type { StandardSchemaV1 } from "@notation/resource";
import { resolveLambda, whenLoaded } from "src/lambda/lambda-declaration";
import type { EventBridgeRuleEvent, RuleOptions } from "src/lambda/declaration";
import type { LambdaGroup } from "src/lambda/lambda";
import type { IdOption } from "src/id";
import type { EventBus } from "./event-bus";

export type RuleConfig<S extends StandardSchemaV1 = StandardSchemaV1> =
  RuleOptions<S> & {
    /** The bus that the rule matches events on, from `eventBus()` or `defaultEventBus()`. */
    bus: EventBus<any>;
    /**
     * The Lambda that the rule sends the events to: a declaration from
     * `$lambda`, passed as `() => lambda`, or a Lambda group from
     * `lambda()`. A declaration must be declared with
     * `event: () => eventBridge.schema(schema)`, with the rule's schema, or
     * with no event.
     */
    target: RuleTarget<NoInfer<S>>;
  };

/** A Lambda that can receive the events of a rule whose schema has the type `S`. */
export type RuleTarget<S extends StandardSchemaV1> =
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
export function rule<
  S extends StandardSchemaV1,
  const Id extends string = never,
>(config: Omit<RuleConfig<S>, "id"> & { id: IdOption<Id> }): void {
  const { bus, target, ...options } = config;
  whenLoaded(() => {
    const { group, event } = resolveLambda(target, "rule()", "eventBridge");
    if (event?.kind === "eventBridge" && event.schema !== options.schema) {
      throw new Error(
        `rule() sends the events of the rule "${options.id}" to the Lambda "${group.id}", but the Lambda's event: () => ${event.schema ? "eventBridge.schema(schema) has another schema than the rule" : "eventBridge.schema(null) receives scheduled events, which have no detail"}. Give rule() and eventBridge.schema() the same schema, imported from a shared module.`,
      );
    }
    bus["~rule"](group, options, "rule()");
  });
}
