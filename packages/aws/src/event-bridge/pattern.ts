/**
 * A value in an event pattern: a value that the field must equal, or a
 * content filter, such as `{ prefix: "order-" }`, `{ "anything-but": "test" }`
 * or `{ numeric: [">", 100] }`.
 */
export type PatternMatcher =
  string | number | boolean | null | { [filter: string]: unknown };

/**
 * The fields of an event's detail to match. Each field holds a list of
 * values, any of which matches, or the pattern of a nested object.
 */
export type DetailPattern = {
  [field: string]: PatternMatcher[] | DetailPattern;
};

/**
 * The events that a rule matches. Each field holds a list of values, any of
 * which matches. An event matches when each field in the pattern matches.
 * See https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html
 */
export type EventPattern = {
  source?: PatternMatcher[];
  "detail-type"?: PatternMatcher[];
  account?: PatternMatcher[];
  region?: PatternMatcher[];
  resources?: PatternMatcher[];
  detail?: DetailPattern;
};
