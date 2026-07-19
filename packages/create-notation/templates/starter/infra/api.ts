import { api, router } from "@notation/aws/api-gateway";
import { getTodos } from "runtime/todos.fn";

const todoApi = api({ name: "todo-api" });
const todoRouter = router(todoApi);

todoRouter.get("/todos", getTodos);
