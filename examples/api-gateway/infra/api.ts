import { api, router } from "@notation/aws/api-gateway";
import {
  getTodos,
  getTodoCount,
} from "runtime/todos.fn" with { type: "runtime" };

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", getTodos);
todoRouter.get("/todos/count", getTodoCount);
