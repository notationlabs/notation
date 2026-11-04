// Written as `notation types` would write it, with the view types from
// @notation/resource, since this package doesn't depend on @notation/core.

declare module "@notation/aws/lambda*" with { type: "infra" } {
  const view: import("@notation/resource").RuntimeView<typeof import("@notation/aws/lambda")>;
  export = view;
}
declare module "../infra/orders*" with { type: "infra" } {
  const view: import("@notation/resource").RuntimeView<typeof import("./infra/orders")>;
  export = view;
}
declare module "../runtime/checkout*" with { type: "runtime" } {
  const view: import("@notation/resource").InfraView<typeof import("./runtime/checkout")>;
  export = view;
}
