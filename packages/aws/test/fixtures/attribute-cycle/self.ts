import * as self from "./self" with { type: "runtime" };

export const name = "self";

console.log(Object.keys(self).join(","));
