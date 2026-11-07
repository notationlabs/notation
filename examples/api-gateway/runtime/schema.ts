import * as v from "valibot";

export const NewTodo = v.object({
  title: v.pipe(v.string(), v.nonEmpty()),
  completed: v.optional(v.boolean(), false),
});
