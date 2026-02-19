import type { ResourceCollector } from "@notation/core";
import { api, router } from "@notation/aws/api-gateway";
import { getTodos } from "runtime/todos.fn";

export function register(collector: ResourceCollector) {
  const todoApi = api(collector, { name: "todo-api" });
  const todoRouter = router(collector, todoApi);

  todoRouter.get("/todos", getTodos);
}
